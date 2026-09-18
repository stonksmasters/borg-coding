import type { EngineeringDiscipline, EngineeringRole } from "../../../packages/core/src/contracts.ts";
import type { PermissionMode, ToolBroker, ToolCall } from "../../../packages/tools/src/tool-broker.ts";
import type { TaskToolContext } from "../../../packages/tools/src/worktree-tools.ts";

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
}

interface AgentOptions {
  ollamaUrl: string;
  model: string;
  messages: OllamaMessage[];
  tools: ToolBroker;
  mode: PermissionMode;
  taskContext?: TaskToolContext;
  role?: EngineeringRole;
  disciplines?: readonly EngineeringDiscipline[];
  phase?: "plan" | "implementation";
  streamText?: boolean;
  limits?: Partial<AgentLimits>;
  emit(event: Record<string, unknown>): void;
}

interface AgentLimits {
  toolRounds: number;
  toolCalls: number;
  toolOutputCharacters: number;
  identicalCalls: number;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, Math.floor(parsed))) : fallback;
}

function agentLimits(overrides?: Partial<AgentLimits>): AgentLimits {
  return {
    toolRounds: boundedInteger(overrides?.toolRounds ?? process.env.BORG_MAX_TOOL_ROUNDS, 30, 1, 60),
    toolCalls: boundedInteger(overrides?.toolCalls ?? process.env.BORG_MAX_TOOL_CALLS, 60, 1, 120),
    toolOutputCharacters: boundedInteger(overrides?.toolOutputCharacters ?? process.env.BORG_MAX_TOOL_OUTPUT_CHARACTERS, 240_000, 10_000, 500_000),
    identicalCalls: boundedInteger(overrides?.identicalCalls ?? process.env.BORG_MAX_IDENTICAL_CALLS, 3, 1, 5),
  };
}

async function runTurn(options: AgentOptions, allowTools = true): Promise<OllamaMessage> {
  const toolDefinitions = allowTools ? options.tools.toolDefinitions(options.mode, options.taskContext, options.role, options.disciplines) : [];
  const response = await fetch(`${options.ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: options.model, stream: true, messages: options.messages, tools: toolDefinitions }),
  });
  if (!response.ok || !response.body) throw new Error(`Ollama returned ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const toolCalls: ToolCall[] = [];
  let responseStageStarted = false;
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const chunk = JSON.parse(line) as { message?: { content?: string; tool_calls?: ToolCall[] }; error?: string };
      if (chunk.error) throw new Error(chunk.error);
      const text = chunk.message?.content ?? "";
      if (text) {
        if (!responseStageStarted) {
          options.emit({ type: "stage.updated", stage: options.phase === "implementation" ? "Implementation" : "Plan", status: "active" });
          responseStageStarted = true;
        }
        content += text;
        if (options.streamText !== false) options.emit({ type: "message.delta", text });
      }
      if (chunk.message?.tool_calls?.length) toolCalls.push(...chunk.message.tool_calls);
    }
    if (done) break;
  }
  return { role: "assistant", content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
}

export async function runOllamaAgent(options: AgentOptions) {
  const limits = agentLimits(options.limits);
  const toolDefinitions = options.tools.toolDefinitions(options.mode, options.taskContext, options.role);
  options.emit({ type: "runtime.connected", runtime: "ollama", model: options.model, role: options.role ?? null });
  if (toolDefinitions.some((tool) => tool.function.name.startsWith("repository_"))) options.emit({ type: "stage.updated", stage: "Discovery", status: "active" });
  else if (toolDefinitions.length) options.emit({ type: "stage.updated", stage: "Plan", status: "active" });

  let answer = "";
  let usedTools = false;
  let toolCallCount = 0;
  let toolOutputCharacters = 0;
  let budgetReason = "tool-round limit";
  const repeatedCalls = new Map<string, number>();
  for (let round = 0; round < limits.toolRounds; round += 1) {
    const assistant = await runTurn(options);
    options.messages.push(assistant);
    answer += assistant.content;
    const calls = assistant.tool_calls ?? [];
    if (!calls.length) {
      if (toolDefinitions.length) options.emit({ type: "stage.updated", stage: options.phase === "implementation" ? "Implementation" : "Plan", status: "complete" });
      return { answer, usedTools };
    }

    usedTools = true;
    for (const call of calls) {
      if (toolCallCount >= limits.toolCalls || toolOutputCharacters >= limits.toolOutputCharacters) {
        budgetReason = toolCallCount >= limits.toolCalls ? "tool-call limit" : "tool-output limit";
        break;
      }
      toolCallCount += 1;
      const signature = `${call.function.name}:${JSON.stringify(call.function.arguments)}`;
      const repeats = (repeatedCalls.get(signature) ?? 0) + 1;
      repeatedCalls.set(signature, repeats);
      if (call.function.name === "activity_update") {
        try {
          const activity = await options.tools.execute(call, options.mode, options.taskContext, options.role, options.disciplines);
          options.emit({ type: "activity.updated", activity });
          options.messages.push({ role: "tool", tool_name: call.function.name, content: JSON.stringify({ acknowledged: true, activity }) });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Activity update failed";
          options.emit({ type: "tool.failed", tool: call.function.name, message });
          options.messages.push({ role: "tool", tool_name: call.function.name, content: JSON.stringify({ error: message }) });
        }
        continue;
      }
      options.emit({ type: "tool.started", tool: call.function.name, input: call.function.arguments });
      if (repeats > limits.identicalCalls) {
        const message = "Blocked repeated identical tool call. Use the results already provided.";
        options.emit({ type: "tool.failed", tool: call.function.name, message });
        options.messages.push({ role: "tool", tool_name: call.function.name, content: JSON.stringify({ error: message }) });
        continue;
      }
      try {
        const output = await options.tools.execute(call, options.mode, options.taskContext, options.role, options.disciplines);
        options.emit({ type: "tool.completed", tool: call.function.name, output });
        const serialized = JSON.stringify(output);
        const remaining = Math.max(0, limits.toolOutputCharacters - toolOutputCharacters);
        const content = serialized.slice(0, Math.min(30_000, remaining));
        toolOutputCharacters += content.length;
        options.messages.push({ role: "tool", tool_name: call.function.name, content });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Tool failed";
        options.emit({ type: "tool.failed", tool: call.function.name, message });
        options.messages.push({ role: "tool", tool_name: call.function.name, content: JSON.stringify({ error: message }) });
      }
    }
    if (options.phase !== "implementation" && calls.some((call) => call.function.name.startsWith("repository_"))) {
      options.emit({ type: "stage.updated", stage: "Discovery", status: "complete" });
      options.emit({ type: "stage.updated", stage: "Plan", status: "active" });
    }
    if (toolCallCount >= limits.toolCalls || toolOutputCharacters >= limits.toolOutputCharacters) break;
  }

  options.emit({ type: "runtime.notice", message: `${options.phase === "implementation" ? "Implementation" : "Discovery"} reached its ${budgetReason}; BORG is completing from collected evidence.` });
  options.messages.push({ role: "system", content: "The bounded tool budget is exhausted. Do not request more tools. Give the best complete answer possible from the evidence already collected, and clearly identify any remaining uncertainty." });
  const finalAssistant = await runTurn(options, false);
  answer += finalAssistant.content;
  options.emit({ type: "stage.updated", stage: options.phase === "implementation" ? "Implementation" : "Plan", status: "complete" });
  return { answer, usedTools, budgetExhausted: true };
}
