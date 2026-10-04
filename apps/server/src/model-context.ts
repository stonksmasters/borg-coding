import { createHash } from "node:crypto";

export interface ObservationReceipt {
  id: string;
  sha256: string;
  characters: number;
  tool: string;
}

export function observationKey(tool: string, content: string): string {
  return createHash("sha256").update(JSON.stringify([tool, content])).digest("hex");
}

export interface ContextMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: unknown[];
  tool_name?: string;
}

/** Rebuild from immutable history, retaining all authority and the two newest exchanges. */
export function rebuildImplementationContext<T extends ContextMessage>(
  history: readonly T[],
  receipts: ReadonlyMap<string, ObservationReceipt>,
  maximum: number,
  requestSize: (messages: T[]) => number,
): { messages: T[]; archivedObservations: number } {
  const deduplicated = compactImplementationContext(history);
  if (requestSize(deduplicated) <= maximum) return { messages: deduplicated, archivedObservations: 0 };
  // Start from originals so duplicate references never point to an archived body.
  const messages = history.map((message) => ({ ...message }));
  const exchanges = messages.flatMap((message, index) => message.role === "assistant" && message.tool_calls?.length ? [index] : []);
  const protectFrom = exchanges.at(-2) ?? 0;
  let archivedObservations = 0;
  for (let index = 0; index < protectFrom && requestSize(messages) > maximum; index += 1) {
    const original = history[index];
    if (original.role !== "tool" || !["worktree_read", "worktree_read_many", "worktree_stat", "worktree_list"].includes(original.tool_name ?? "")) continue;
    const receipt = receipts.get(observationKey(original.tool_name!, original.content));
    if (!receipt) continue; // Never discard an observation that was not durably saved.
    const content = JSON.stringify({
      archivedObservation: receipt,
      retrieve: { tool: "worktree_observation_read", observation_id: receipt.id, offset: 0 },
      note: "Historical evidence, not current file state. Retrieve if needed; use worktree_read for exact current source before patching. No verification or mutation is implied.",
    });
    if (content.length >= messages[index].content.length) continue;
    messages[index] = { ...messages[index], content };
    archivedObservations += 1;
  }
  return { messages: compactImplementationContext(messages), archivedObservations };
}

/** Remove only redundant observations; retain authority and complete tool exchanges. */
export function compactImplementationContext<T extends ContextMessage>(messages: readonly T[]): T[] {
  const seen = new Set<string>();
  const result = messages.map((message) => ({ ...message }));
  for (let index = result.length - 1; index >= 0; index -= 1) {
    const message = result[index];
    if (message.role !== "tool" || !["worktree_read", "worktree_read_many", "worktree_stat", "worktree_list"].includes(message.tool_name ?? "")) continue;
    const identity = `${message.tool_name}:${message.content}`;
    if (seen.has(identity)) {
      const receipt = JSON.stringify({ redundantObservation: true, note: "The identical tool result is included later in this context. Use that exact observation." });
      if (receipt.length < message.content.length) result[index] = { ...message, content: receipt };
    } else seen.add(identity);
  }
  return result;
}

export function requestBreakdown(messages: readonly ContextMessage[], tools: readonly unknown[], body: string) {
  const characters = { system: 0, user: 0, assistant: 0, tool: 0 };
  for (const message of messages) characters[message.role] += JSON.stringify(message).length;
  const toolSchemaCharacters = JSON.stringify(tools).length;
  const envelopeCharacters = body.length - toolSchemaCharacters - Object.values(characters).reduce((sum, count) => sum + count, 0);
  return { characters, toolSchemaCharacters, envelopeCharacters, totalCharacters: body.length, messageCount: messages.length };
}
