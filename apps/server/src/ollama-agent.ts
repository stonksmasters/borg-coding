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

const MODEL_REQUEST_CHARACTERS = 72_000;

function trimContent(message: OllamaMessage, maximum: number): OllamaMessage {
  if (message.content.length <= maximum) return message;
  const marker = "\n[Earlier content omitted; read the project docs or worktree for details.]\n";
  const room = Math.max(0, maximum - marker.length);
  const head = Math.floor(room * 0.65);
  return { ...message, content: message.content.slice(0, head) + marker + message.content.slice(-Math.max(0, room - head)) };
}

export function modelMessages(messages: OllamaMessage[], maximumCharacters: number): OllamaMessage[] {
  if (JSON.stringify(messages).length <= maximumCharacters) return messages;
  const pinned = messages.slice(0, 2).map((message, index) => trimContent(message, Math.min(index === 0 ? 14_000 : 8_000, Math.floor(maximumCharacters * 0.3))));
  const suffix: OllamaMessage[] = [];
  let remaining = maximumCharacters - JSON.stringify(pinned).length - 500;
  for (let index = messages.length - 1; index >= pinned.length; index -= 1) {
    if (remaining < 1000) break;
    const candidate = trimContent(messages[index], Math.min(12_000, remaining - 200));
    const size = JSON.stringify(candidate).length;
    if (size > remaining) break;
    suffix.unshift(candidate);
    remaining -= size;
  }
  const result = [
    ...pinned,
    { role: "system", content: "Earlier model and tool turns were omitted to fit the local model context. Inspect the worktree or call read tools again when earlier details are needed; do not assume an omitted action succeeded." },
    ...suffix,
  ] as OllamaMessage[];
  while (JSON.stringify(result).length > maximumCharacters && result.length > 3) result.splice(3, 1);
  if (result[3]?.role === "tool") result[3] = { role: "system", content: `Latest tool result from earlier context:\n${result[3].content}` };
  while (JSON.stringify(result).length > maximumCharacters && result.length > 3) result.splice(3, 1);
  return result;
}

function isTransientModelFailure(message: string): boolean {
  return /\bterminated\b|fetch failed|network error|Ollama returned 50[0234]/i.test(message);
}

function parseTextToolValue(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^(?:true|false|null|-?\d+(?:\.\d+)?)$/.test(trimmed) || /^[\[{]/.test(trimmed)) {
    try { return JSON.parse(trimmed); } catch { }
  }
  return trimmed;
}

export function parseTextToolCalls(content: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const callPattern = /<function=([a-zA-Z0-9_.:-]+)>\s*([\s\S]*?)<\/function>\s*(?:<\/tool_call>)?/g;
  for (const match of content.matchAll(callPattern)) {
    const args: Record<string, unknown> = {};
    const parameterPattern = /<parameter=([a-zA-Z0-9_.:-]+)>\s*([\s\S]*?)<\/parameter>/g;
    for (const parameter of match[2].matchAll(parameterPattern)) args[parameter[1]] = parseTextToolValue(parameter[2]);
    calls.push({ function: { name: match[1], arguments: args } });
  }
  return calls;
}

function stripTextToolCalls(content: string): string {
  return content
    .replace(/<function=[a-zA-Z0-9_.:-]+>\s*[\s\S]*?<\/function>\s*(?:<\/tool_call>)?/g, "")
    .trim();
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
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const target = attempt ? 40_000 : MODEL_REQUEST_CHARACTERS;
    const toolCharacters = JSON.stringify(toolDefinitions).length;
    const messages = modelMessages(options.messages, Math.max(8_000, target - toolCharacters - 1_000));
    const requestBody = JSON.stringify({ model: options.model, stream: true, messages, tools: toolDefinitions });
    options.emit({ type: "runtime.turn.started", attempt: attempt + 1, messages: messages.length, requestCharacters: requestBody.length, omittedMessages: options.messages.length - messages.length });
    let streamedText = false;
    try {
      const response = await fetch(`${options.ollamaUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody,
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
            streamedText = true;
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cause = error instanceof Error && error.cause instanceof Error ? `${error.cause.name}: ${error.cause.message}` : null;
      options.emit({ type: "runtime.turn.failed", attempt: attempt + 1, message, cause, streamedText });
      if (attempt === 0 && !streamedText && isTransientModelFailure(message)) {
        options.emit({ type: "runtime.turn.retrying", message: "The local model turn stopped before returning text. Retrying once with a smaller context." });
        continue;
      }
      throw error;
    }
  }
  throw new Error("Ollama model turn failed after retry.");
}

export async function runOllamaAgent(options: AgentOptions) {
  const limits = agentLimits(options.limits);
  const toolDefinitions = options.tools.toolDefinitions(options.mode, options.taskContext, options.role, options.disciplines);
  options.emit({ type: "runtime.connected", runtime: "ollama", model: options.model, role: options.role ?? null });
  if (toolDefinitions.some((tool) => tool.function.name.startsWith("repository_"))) options.emit({ type: "stage.updated", stage: "Discovery", status: "active" });
  else if (toolDefinitions.length) options.emit({ type: "stage.updated", stage: "Plan", status: "active" });

  let answer = "";
  let usedTools = false;
  let toolCallCount = 0;
  let toolOutputCharacters = 0;
  let budgetReason = "tool-round limit";
  const repeatedCalls = new Map<string, number>();
  const invalidToolFailures = new Map<string, number>();
  const availableToolNames = toolDefinitions.map((tool) => tool.function.name);
  for (let round = 0; round < limits.toolRounds; round += 1) {
    const assistant = await runTurn(options);
    const nativeCalls = assistant.tool_calls ?? [];
    const recoveredCalls = nativeCalls.length
      ? []
      : parseTextToolCalls(assistant.content).filter((call) => availableToolNames.includes(call.function.name));
    const calls = nativeCalls.length ? nativeCalls : recoveredCalls;
    const visibleContent = recoveredCalls.length ? stripTextToolCalls(assistant.content) : assistant.content;
    options.messages.push(recoveredCalls.length ? { ...assistant, content: visibleContent, tool_calls: recoveredCalls } : assistant);
    if (visibleContent) answer += visibleContent;

    if (recoveredCalls.length) {
      options.emit({
        type: "runtime.tool_protocol.recovered",
        tools: recoveredCalls.map((call) => call.function.name),
        message: "Recovered a model tool call that was emitted as text instead of structured tool-call data.",
      });
    }

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
        options.messages.push({ role: "tool", tool_name: call.function.name, content: JSON.stringify({ error: message, available_tools: availableToolNames }) });
        const invalid = /unknown|unavailable|cannot invoke|requires EDIT or AGENT|not configured/i.test(message);
        if (invalid) {
          const failures = (invalidToolFailures.get(call.function.name) ?? 0) + 1;
          invalidToolFailures.set(call.function.name, failures);
          if (failures >= 2) throw new Error(`Model repeatedly requested unavailable tool "${call.function.name}". Available tools: ${availableToolNames.join(", ") || "none"}.`);
        }
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
