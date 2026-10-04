import type { EngineeringDiscipline, EngineeringRole } from "../../../packages/core/src/contracts.ts";
import type { PermissionMode, ToolBroker, ToolCall } from "../../../packages/tools/src/tool-broker.ts";
import type { TaskToolContext } from "../../../packages/tools/src/worktree-tools.ts";
import { observationKey, rebuildImplementationContext, requestBreakdown, type ObservationReceipt } from "./model-context.ts";

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
  allowTools?: boolean;
  maxRequestCharacters?: number;
  emit(event: Record<string, unknown>): void;
  onRequestBody?(body: string): void;
  recordObservation?(tool: string, output: unknown): ObservationReceipt;
}

interface AgentLimits {
  toolRounds: number;
  toolCalls: number;
  toolOutputCharacters: number;
  identicalCalls: number;
}

const MODEL_REQUEST_CHARACTERS = 72_000;
const DEVSTRAL_CONTEXT_LENGTH = 16_384;
const DEVSTRAL_MAX_PREDICT = 2_048;

export function ollamaInferenceOptions(model: string) {
  if (!/^devstral-small-2(?::|$)/i.test(model)) return undefined;
  return {
    temperature: 0.2,
    num_ctx: DEVSTRAL_CONTEXT_LENGTH,
    num_predict: DEVSTRAL_MAX_PREDICT,
  };
}

function trimContent(message: OllamaMessage, maximum: number): OllamaMessage {
  if (message.content.length <= maximum) return message;
  const marker = "\n[Earlier content omitted; read the project docs or worktree for details.]\n";
  const room = Math.max(0, maximum - marker.length);
  const head = Math.floor(room * 0.65);
  return { ...message, content: message.content.slice(0, head) + marker + message.content.slice(-Math.max(0, room - head)) };
}

export function modelMessages(messages: OllamaMessage[], maximumCharacters: number): OllamaMessage[] {
  if (JSON.stringify(messages).length <= maximumCharacters) return messages;
  const systemBudget = Math.min(30_000, Math.max(4_000, Math.floor(maximumCharacters * 0.55)));
  const requestBudget = Math.min(10_000, Math.max(2_000, Math.floor(maximumCharacters * 0.18)));
  const pinned = messages.slice(0, 2).map((message, index) => trimContent(message, index === 0 ? systemBudget : requestBudget));
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

function isModelToolProtocolFailure(message: string): boolean {
  return /XML syntax error|element <[^>]+> closed by <\/[^>]+>|malformed (?:XML|tool(?:[ -]call)?)/i.test(message);
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

async function runTurn(options: AgentOptions, allowTools = true, receipts: ReadonlyMap<string, ObservationReceipt> = new Map()): Promise<OllamaMessage> {
  const toolDefinitions = allowTools ? options.tools.toolDefinitions(options.mode, options.taskContext, options.role, options.disciplines) : [];
  const configuredMaximum = boundedInteger(options.maxRequestCharacters, MODEL_REQUEST_CHARACTERS, 8_000, MODEL_REQUEST_CHARACTERS);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const target = attempt && options.phase !== "implementation" ? Math.min(40_000, configuredMaximum) : configuredMaximum;
    const toolCharacters = JSON.stringify(toolDefinitions).length;
    const inferenceOptions = ollamaInferenceOptions(options.model);
    const serialize = (messages: OllamaMessage[]) => JSON.stringify({
      model: options.model,
      stream: true,
      think: false,
      ...(inferenceOptions ? { options: inferenceOptions } : {}),
      messages,
      tools: toolDefinitions,
    });
    const rebuilt = options.phase === "implementation"
      ? rebuildImplementationContext(options.messages, allowTools && toolDefinitions.some((tool) => tool.function.name === "worktree_observation_read") ? receipts : new Map(), target, (messages) => serialize(messages).length)
      : { messages: modelMessages(options.messages, Math.max(8_000, target - toolCharacters - 1_000)), archivedObservations: 0 };
    const messages = rebuilt.messages;
    const requestBody = serialize(messages);
    if (rebuilt.archivedObservations) options.emit({ type: "runtime.context.rebuilt", archivedObservations: rebuilt.archivedObservations, beforeCharacters: serialize(options.messages).length, afterCharacters: requestBody.length });
    options.emit({ type: "runtime.context.accounted", ...requestBreakdown(messages, toolDefinitions, requestBody), maximumCharacters: target, attempt: attempt + 1, phase: options.phase ?? null, savedMessageCharacters: JSON.stringify(options.messages).length - JSON.stringify(messages).length, accepted: requestBody.length <= target });
    if (requestBody.length > target) {
      throw new Error(`CONTEXT_CAPACITY_EXCEEDED: Complete request requires ${requestBody.length} characters; budget is ${target}. Approved requirements and source were preserved. Narrow the work scope before retrying.`);
    }
    options.onRequestBody?.(requestBody);
    options.emit({ type: "runtime.turn.started", attempt: attempt + 1, messages: messages.length, requestCharacters: requestBody.length, omittedMessages: options.messages.length - messages.length });
    const turnStarted = performance.now();
    let firstResponseMs: number | null = null;
    let streamedText = false;
    let partialContent = "";
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
      const toolCalls: ToolCall[] = [];
      let responseStageStarted = false;
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        if (done && buffer.trim()) { lines.push(buffer); buffer = ""; }
        for (const line of lines) {
          if (!line.trim()) continue;
          const chunk = JSON.parse(line) as { message?: { content?: string; tool_calls?: ToolCall[] }; error?: string; done?: boolean; load_duration?: number; prompt_eval_count?: number; prompt_eval_duration?: number; eval_count?: number; eval_duration?: number; total_duration?: number };
          if (chunk.error) throw new Error(chunk.error);
          if (firstResponseMs === null && (chunk.message?.content || chunk.message?.tool_calls?.length)) firstResponseMs = Math.round(performance.now() - turnStarted);
          if (chunk.done) options.emit({
            type: "runtime.inference.measured", model: options.model,
            elapsedMs: Math.round(performance.now() - turnStarted), firstResponseMs,
            promptTokens: chunk.prompt_eval_count ?? null, generatedTokens: chunk.eval_count ?? null,
            loadMs: chunk.load_duration === undefined ? null : chunk.load_duration / 1_000_000,
            promptEvaluationMs: chunk.prompt_eval_duration === undefined ? null : chunk.prompt_eval_duration / 1_000_000,
            generationMs: chunk.eval_duration === undefined ? null : chunk.eval_duration / 1_000_000,
            totalMs: chunk.total_duration === undefined ? null : chunk.total_duration / 1_000_000,
          });
          const text = chunk.message?.content ?? "";
          if (text) {
            streamedText = true;
            if (!responseStageStarted) {
              options.emit({ type: "stage.updated", stage: options.phase === "implementation" ? "Implementation" : "Plan", status: "active" });
              responseStageStarted = true;
            }
            partialContent += text;
            if (options.streamText !== false) options.emit({ type: "message.delta", text });
          }
          if (chunk.message?.tool_calls?.length) toolCalls.push(...chunk.message.tool_calls);
        }
        if (done) break;
      }
      return { role: "assistant", content: partialContent, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cause = error instanceof Error && error.cause instanceof Error ? `${error.cause.name}: ${error.cause.message}` : null;
      options.emit({ type: "runtime.turn.failed", attempt: attempt + 1, message, cause, streamedText });
      if (options.phase === "plan" && /\bterminated\b/i.test(message) && partialContent.trim().length >= 500) {
        options.emit({ type: "runtime.turn.truncated", message: "The local planner reached its response bound. Preserving its partial plan for deterministic normalization.", characters: partialContent.length });
        return { role: "assistant", content: partialContent };
      }
      const safeToRetry = !streamedText || !allowTools;
      const protocolFailure = isModelToolProtocolFailure(message);
      if (attempt === 0 && (protocolFailure || (safeToRetry && isTransientModelFailure(message)))) {
        options.emit({
          type: protocolFailure ? "runtime.tool_protocol.retrying" : "runtime.turn.retrying",
          message: options.phase === "implementation"
            ? "Retrying the local model once with approved requirements and source preserved."
            : protocolFailure
            ? "The local model emitted a malformed tool call. Retrying once with a smaller context and the same approved worktree state."
            : "The local model turn stopped before returning text. Retrying once with a smaller context.",
        });
        continue;
      }
      throw error;
    }
  }
  throw new Error("Ollama model turn failed after retry.");
}

export async function runOllamaAgent(options: AgentOptions) {
  const receipts = new Map<string, ObservationReceipt>();
  const readCache = new Map<string, { sha256: string; receipt: ObservationReceipt }>();
  let unchangedReads = 0;
  const limits = agentLimits(options.limits);
  const toolsAllowed = options.allowTools !== false;
  const toolDefinitions = toolsAllowed
    ? options.tools.toolDefinitions(options.mode, options.taskContext, options.role, options.disciplines)
    : [];
  options.emit({ type: "runtime.connected", runtime: "ollama", model: options.model, role: options.role ?? null });
  if (toolDefinitions.some((tool) => tool.function.name.startsWith("repository_"))) options.emit({ type: "stage.updated", stage: "Discovery", status: "active" });
  else if (toolDefinitions.length) options.emit({ type: "stage.updated", stage: "Plan", status: "active" });

  let answer = "";
  let usedTools = false;
  let toolCallCount = 0;
  let toolOutputCharacters = 0;
  const toolFailures: string[] = [];
  let budgetReason = "tool-round limit";
  const repeatedCalls = new Map<string, number>();
  const invalidToolFailures = new Map<string, number>();
  const availableToolNames: string[] = toolDefinitions.map((tool) => tool.function.name);
  for (let round = 0; round < limits.toolRounds; round += 1) {
    let assistant: OllamaMessage;
    try { assistant = await runTurn(options, toolsAllowed, receipts); }
    catch (error) {
      if (options.phase === "implementation" && usedTools && error instanceof Error && error.message.startsWith("CONTEXT_CAPACITY_EXCEEDED:")) {
        options.emit({ type: "runtime.context.continuation_required", message: error.message });
        return { answer, usedTools, toolFailures, budgetExhausted: true };
      }
      throw error;
    }
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
      return { answer, usedTools, toolFailures };
    }

    usedTools = true;
    let stalled = false;
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
          if (options.role === "architect") {
            const update = activity as { phase?: string; title?: string; detail?: string };
            if (!["planning", "inspecting"].includes(update.phase ?? "") || /\b(?:implemented|patched|modified|changed|created|fixed|updated|rewrote|added|removed)\b/i.test(`${update.title ?? ""} ${update.detail ?? ""}`)) {
              throw new Error("Architect activity may describe planning and inspection only; no implementation has occurred.");
            }
          }
          options.emit({ type: "activity.updated", activity });
          options.messages.push({ role: "tool", tool_name: call.function.name, content: JSON.stringify({ acknowledged: true, activity }) });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Activity update failed";
          toolFailures.push(message);
          options.emit({ type: "tool.failed", tool: call.function.name, message });
          options.messages.push({ role: "tool", tool_name: call.function.name, content: JSON.stringify({ error: message }) });
        }
        continue;
      }
      if (repeats > limits.identicalCalls) {
        options.emit({ type: "tool.started", tool: call.function.name, input: call.function.arguments });
        const message = "Blocked repeated identical tool call. Use the results already provided.";
        toolFailures.push(message);
        options.emit({ type: "tool.failed", tool: call.function.name, message });
        options.messages.push({ role: "tool", tool_name: call.function.name, content: JSON.stringify({ error: message }) });
        if (options.phase === "implementation") {
          stalled = true;
        }
        continue;
      }
      try {
        const fullRead = call.function.name === "worktree_read" && call.function.arguments.start_line === undefined && call.function.arguments.end_line === undefined;
        const cacheKey = String(call.function.arguments.path ?? "");
        const cached = fullRead && availableToolNames.includes("worktree_observation_read") ? readCache.get(cacheKey) : undefined;
        const effectiveCall = cached ? { ...call, function: { ...call.function, arguments: { ...call.function.arguments, known_sha256: cached.sha256 } } } : call;
        options.emit({ type: "tool.started", tool: call.function.name, input: effectiveCall.function.arguments });
        if (cached) options.emit({ type: "runtime.context.source_checked", path: cacheKey, sha256: cached.sha256 });
        const output = await options.tools.execute(effectiveCall, options.mode, options.taskContext, options.role, options.disciplines);
        options.emit({ type: "tool.completed", tool: call.function.name, output });
        const value = output as { notModified?: boolean; sha256?: string; content?: string } | null;
        const reused = cached && value?.notModified === true && value.sha256 === cached.sha256;
        const serialized = JSON.stringify(reused ? { ...value, path: cacheKey, currentHashVerified: true, retrieve: { tool: "worktree_observation_read", observation_id: cached.receipt.id }, note: "Exact source was read previously. The current file hash still matches that observation. Retrieve that observation or use a line range to obtain exact source." } : output);
        if (fullRead) unchangedReads = reused ? unchangedReads + 1 : 0;
        if (["worktree_write", "worktree_patch", "worktree_command"].includes(call.function.name)) { repeatedCalls.clear(); unchangedReads = 0; readCache.clear(); stalled = false; }
        if (!reused && options.recordObservation && ["worktree_read", "worktree_read_many", "worktree_stat", "worktree_list"].includes(call.function.name) && !(output && typeof output === "object" && "error" in output)) {
          const receipt = options.recordObservation(call.function.name, output);
          receipts.set(observationKey(call.function.name, serialized), receipt);
          if (fullRead && typeof value?.content === "string" && typeof value.sha256 === "string") readCache.set(cacheKey, { sha256: value.sha256, receipt });
        }
        const remaining = Math.max(0, limits.toolOutputCharacters - toolOutputCharacters);
        const maximum = Math.min(30_000, remaining);
        const content = serialized.length <= maximum ? serialized : JSON.stringify({
          truncated: true, originalCharacters: serialized.length,
          note: "Full output is recorded in the tool.completed event. This preview is incomplete and must not be used as exact source for a patch. For source, request worktree_read with start_line/end_line or a smaller batch.",
          preview: serialized.slice(0, Math.max(0, Math.floor((maximum - 600) / 6))),
        });
        toolOutputCharacters += content.length;
        options.messages.push({ role: "tool", tool_name: call.function.name, content });
        if (options.phase === "implementation" && unchangedReads >= 3) {
          stalled = true;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Tool failed";
        toolFailures.push(message);
        options.emit({ type: "tool.failed", tool: call.function.name, message });
        options.messages.push({ role: "tool", tool_name: call.function.name, content: JSON.stringify({ error: message, available_tools: availableToolNames }) });
        const fatalBoundary = /unsafe worktree path|escapes (?:the approved root|through a (?:parent )?link)|outside borg's managed worktree root|does not have an approved worktree|permission denied|EACCES|EPERM/i.test(message);
        if (options.phase === "implementation" && fatalBoundary) throw new Error(message);
        const invalid = /unknown|unavailable|cannot invoke|requires EDIT or AGENT|not configured/i.test(message);
        if (invalid) {
          const failures = (invalidToolFailures.get(call.function.name) ?? 0) + 1;
          invalidToolFailures.set(call.function.name, failures);
          if (failures >= 2) throw new Error(`Model repeatedly requested unavailable tool "${call.function.name}". Available tools: ${availableToolNames.join(", ") || "none"}.`);
        }
      }
    }
    if (stalled && options.phase === "implementation") {
      options.emit({ type: "runtime.context.stalled", message: "Repeated calls produced no new source evidence. Returning to deterministic verification." });
      return { answer, usedTools, toolFailures, budgetExhausted: false };
    }
    if (options.phase !== "implementation" && calls.some((call) => call.function.name.startsWith("repository_"))) {
      options.emit({ type: "stage.updated", stage: "Discovery", status: "complete" });
      options.emit({ type: "stage.updated", stage: "Plan", status: "active" });
    }
    if (toolCallCount >= limits.toolCalls || toolOutputCharacters >= limits.toolOutputCharacters) break;
  }

  if (options.phase === "implementation") {
    options.emit({ type: "runtime.notice", message: `Implementation reached its ${budgetReason}; returning saved work to the orchestrator for continuation or verification.` });
    return { answer, usedTools, budgetExhausted: true, toolFailures };
  }
  options.emit({ type: "runtime.notice", message: `Discovery reached its ${budgetReason}; BORG is completing from collected evidence.` });
  options.messages.push({ role: "system", content: "The bounded tool budget is exhausted. Do not request more tools. Give the best complete answer possible from the evidence already collected, and clearly identify any remaining uncertainty." });
  const finalAssistant = await runTurn(options, false);
  answer += finalAssistant.content;
  options.emit({ type: "stage.updated", stage: "Plan", status: "complete" });
  return { answer, usedTools, budgetExhausted: true, toolFailures };
}
