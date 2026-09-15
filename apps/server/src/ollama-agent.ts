import type { PermissionMode, ToolBroker, ToolCall } from "../../../packages/tools/src/tool-broker.ts";

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
  emit(event: Record<string, unknown>): void;
}

const MAX_TOOL_ROUNDS = 10;
const MAX_TOOL_CALLS = 20;
const MAX_TOOL_OUTPUT_CHARACTERS = 120_000;
const MAX_IDENTICAL_CALLS = 2;

async function runTurn(options: AgentOptions, allowTools = true): Promise<OllamaMessage> {
  const toolDefinitions = allowTools ? options.tools.toolDefinitions(options.mode) : [];
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
        if (!responseStageStarted) { options.emit({ type: "stage.updated", stage: "Plan", status: "active" }); responseStageStarted = true; }
        content += text;
        options.emit({ type: "message.delta", text });
      }
      if (chunk.message?.tool_calls?.length) toolCalls.push(...chunk.message.tool_calls);
    }
    if (done) break;
  }
  return { role: "assistant", content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
}

export async function runOllamaAgent(options: AgentOptions) {
  const toolDefinitions = options.tools.toolDefinitions(options.mode);
  options.emit({ type: "runtime.connected", runtime: "ollama", model: options.model });
  if (toolDefinitions.some((tool) => tool.function.name.startsWith("repository_"))) options.emit({ type: "stage.updated", stage: "Discovery", status: "active" });
  else if (toolDefinitions.length) options.emit({ type: "stage.updated", stage: "Plan", status: "active" });

  let answer = "";
  let usedTools = false;
  let toolCallCount = 0;
  let toolOutputCharacters = 0;
  let budgetReason = "tool-round limit";
  const repeatedCalls = new Map<string, number>();
  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const assistant = await runTurn(options);
    options.messages.push(assistant);
    answer += assistant.content;
    const calls = assistant.tool_calls ?? [];
    if (!calls.length) {
      if (toolDefinitions.length) options.emit({ type: "stage.updated", stage: "Plan", status: "complete" });
      return { answer, usedTools };
    }

    usedTools = true;
    for (const call of calls) {
      if (toolCallCount >= MAX_TOOL_CALLS || toolOutputCharacters >= MAX_TOOL_OUTPUT_CHARACTERS) {
        budgetReason = toolCallCount >= MAX_TOOL_CALLS ? "tool-call limit" : "tool-output limit";
        break;
      }
      toolCallCount += 1;
      const signature = `${call.function.name}:${JSON.stringify(call.function.arguments)}`;
      const repeats = (repeatedCalls.get(signature) ?? 0) + 1;
      repeatedCalls.set(signature, repeats);
      options.emit({ type: "tool.started", tool: call.function.name, input: call.function.arguments });
      if (repeats > MAX_IDENTICAL_CALLS) {
        const message = "Blocked repeated identical tool call. Use the results already provided.";
        options.emit({ type: "tool.failed", tool: call.function.name, message });
        options.messages.push({ role: "tool", tool_name: call.function.name, content: JSON.stringify({ error: message }) });
        continue;
      }
      try {
        const output = await options.tools.execute(call, options.mode);
        options.emit({ type: "tool.completed", tool: call.function.name, output });
        const serialized = JSON.stringify(output);
        const remaining = Math.max(0, MAX_TOOL_OUTPUT_CHARACTERS - toolOutputCharacters);
        const content = serialized.slice(0, Math.min(30_000, remaining));
        toolOutputCharacters += content.length;
        options.messages.push({ role: "tool", tool_name: call.function.name, content });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Tool failed";
        options.emit({ type: "tool.failed", tool: call.function.name, message });
        options.messages.push({ role: "tool", tool_name: call.function.name, content: JSON.stringify({ error: message }) });
      }
    }
    if (calls.some((call) => call.function.name.startsWith("repository_"))) {
      options.emit({ type: "stage.updated", stage: "Discovery", status: "complete" });
      options.emit({ type: "stage.updated", stage: "Plan", status: "active" });
    }
    if (toolCallCount >= MAX_TOOL_CALLS || toolOutputCharacters >= MAX_TOOL_OUTPUT_CHARACTERS) break;
  }

  options.emit({ type: "runtime.notice", message: `Discovery reached its ${budgetReason}; BORG is completing the plan from collected evidence.` });
  options.messages.push({ role: "system", content: "The bounded discovery budget is exhausted. Do not request more tools. Give the best complete answer or plan possible from the evidence already collected, and clearly identify any remaining uncertainty." });
  const finalAssistant = await runTurn(options, false);
  answer += finalAssistant.content;
  options.emit({ type: "stage.updated", stage: "Plan", status: "complete" });
  return { answer, usedTools, budgetExhausted: true };
}
