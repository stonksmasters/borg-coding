import { randomUUID } from "node:crypto";
import { AgentTurnSchema, type AgentEvent, type AgentTurn, type ApprovalRequest, type ModelAdapter, type PermissionMode } from "@borg/core";
import { permissionDecision } from "@borg/permissions";
import { WorkspaceTools } from "@borg/tools";

const SYSTEM_PROMPT = `You are BORG, a local-first autonomous software engineering agent.
You work against one selected repository. Inspect before editing, make minimal coherent changes, and verify before declaring implementation work complete.

You MUST respond with exactly one JSON object and no markdown.

To use a tool:
{"type":"tool","tool":"read_file|write_file|search_text|git_status|git_diff|run_command|verify","input":{...},"reason":"short reason"}

When the task is complete:
{"type":"final","text":"concise user-facing result"}

Tool inputs:
- read_file: {"path":"relative/path"}
- write_file: {"path":"relative/path","content":"complete replacement content"}
- search_text: {"query":"text or regex for ripgrep"}
- git_status: {}
- git_diff: {}
- run_command: {"command":"program","args":["arg1","arg2"]}
- verify: {}

Never invent tool results. Never claim a command or edit happened until its tool result says it happened. After edits, inspect git_diff and run verify before finalizing whenever practical.`;

function now(): string {
  return new Date().toISOString();
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) return JSON.parse(fenced.trim());
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("Model did not return a JSON action");
  }
}

function compact(value: unknown, max = 24000): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text;
}

export interface AgentRunOptions {
  taskId: string;
  prompt: string;
  workspaceRoot: string;
  permissionMode: PermissionMode;
  onEvent: (event: AgentEvent) => void;
  requestApproval: (request: ApprovalRequest) => Promise<boolean>;
  maxTurns?: number;
}

export class BorgAgent {
  constructor(private readonly model: ModelAdapter) {}

  async run(options: AgentRunOptions): Promise<string> {
    const tools = new WorkspaceTools(options.workspaceRoot);
    let transcript = `USER TASK:\n${options.prompt}\n\nWORKSPACE:\n${options.workspaceRoot}\n\nPERMISSION MODE:\n${options.permissionMode}`;
    const maxTurns = options.maxTurns ?? 16;

    options.onEvent({ type: "agent.status", taskId: options.taskId, at: now(), message: "Inspecting task" });

    for (let turnIndex = 0; turnIndex < maxTurns; turnIndex += 1) {
      const raw = await this.model.generate({ system: SYSTEM_PROMPT, prompt: `${transcript}\n\nReturn the next JSON action.` });
      let turn: AgentTurn;
      try {
        turn = AgentTurnSchema.parse(extractJson(raw));
      } catch (error) {
        transcript += `\n\nINVALID MODEL RESPONSE:\n${compact(raw, 6000)}\n\nPARSER FEEDBACK:\n${error instanceof Error ? error.message : String(error)}\nReturn valid JSON only.`;
        continue;
      }

      if (turn.type === "final") {
        options.onEvent({ type: "task.completed", taskId: options.taskId, at: now(), text: turn.text });
        return turn.text;
      }

      const decision = permissionDecision(options.permissionMode, turn.tool);
      if (decision === "approval") {
        const approvalId = randomUUID();
        const request: ApprovalRequest = { approvalId, taskId: options.taskId, tool: turn.tool, input: turn.input, reason: turn.reason };
        options.onEvent({ type: "approval.required", at: now(), ...request });
        const approved = await options.requestApproval(request);
        options.onEvent({ type: "approval.resolved", taskId: options.taskId, at: now(), approvalId, approved });
        if (!approved) {
          transcript += `\n\nACTION:\n${JSON.stringify(turn)}\n\nTOOL RESULT:\nUser denied permission. Choose a safer alternative or explain what cannot proceed.`;
          continue;
        }
      }

      options.onEvent({ type: "tool.started", taskId: options.taskId, at: now(), tool: turn.tool, input: turn.input });
      try {
        const result = await tools.execute(turn);
        options.onEvent({ type: "tool.completed", taskId: options.taskId, at: now(), tool: turn.tool, output: result, ok: true });
        transcript += `\n\nACTION:\n${JSON.stringify(turn)}\n\nTOOL RESULT:\n${compact(result)}`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.onEvent({ type: "tool.completed", taskId: options.taskId, at: now(), tool: turn.tool, output: { error: message }, ok: false });
        transcript += `\n\nACTION:\n${JSON.stringify(turn)}\n\nTOOL ERROR:\n${message}`;
      }
    }

    throw new Error(`BORG exceeded the ${maxTurns}-turn safety limit without producing a final response`);
  }
}
