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

async function runTurn(options: AgentOptions): Promise<OllamaMessage> {
  const toolDefinitions = options.tools.toolDefinitions(options.mode);
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
  for (let round = 0; round < 5; round += 1) {
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
      options.emit({ type: "tool.started", tool: call.function.name, input: call.function.arguments });
      try {
        const output = await options.tools.execute(call, options.mode);
        options.emit({ type: "tool.completed", tool: call.function.name, output });
        options.messages.push({ role: "tool", tool_name: call.function.name, content: JSON.stringify(output).slice(0, 30_000) });
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
  }
  throw new Error("Tool loop reached its five-round safety limit.");
}
