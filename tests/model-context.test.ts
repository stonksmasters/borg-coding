import assert from "node:assert/strict";
import test from "node:test";
import { compactImplementationContext, observationKey, rebuildImplementationContext, requestBreakdown, type ContextMessage } from "../apps/server/src/model-context.ts";

test("pressure rebuild archives only durable old reads and preserves recent exchanges and failure evidence", () => {
  const messages: ContextMessage[] = [{ role: "system", content: "full approved design" }, { role: "user", content: "full requirements" }];
  for (let i = 0; i < 4; i++) {
    messages.push({ role: "assistant", content: `step ${i}`, tool_calls: [{ function: { name: "worktree_read", arguments: { path: `${i}.tsx` } } }] });
    messages.push({ role: "tool", tool_name: "worktree_read", content: JSON.stringify({ path: `${i}.tsx`, content: String(i).repeat(3000) }) });
  }
  messages.splice(4, 0, { role: "tool", tool_name: "verification_run", content: "Failure evidence must remain" });
  const snapshot = JSON.stringify(messages);
  const old = messages[3];
  const receipts = new Map([[observationKey(old.tool_name!, old.content), { id: "saved", tool: old.tool_name!, characters: old.content.length, sha256: "a".repeat(64) }]]);
  const result = rebuildImplementationContext(messages, receipts, 11_000, (items) => JSON.stringify(items).length);
  assert.equal(result.archivedObservations, 1);
  assert.ok(JSON.stringify(result.messages).length <= 11_000);
  assert.deepEqual(result.messages.slice(0, 3), messages.slice(0, 3));
  assert.deepEqual(result.messages.slice(4), messages.slice(4));
  assert.equal(JSON.parse(result.messages[3].content).retrieve.observation_id, "saved");
  assert.equal(JSON.stringify(messages), snapshot);
  assert.deepEqual(rebuildImplementationContext(messages, new Map(), 100, (items) => JSON.stringify(items).length).messages, messages);
});

test("compaction preserves repair authority, changed source and tool envelopes without mutating history", () => {
  const source = JSON.stringify({ path: "app.tsx", content: "original\r\n".repeat(100) });
  const messages: ContextMessage[] = [
    { role: "system", content: "repair boundary" },
    { role: "system", content: "approved product contract" },
    { role: "user", content: "approved design requirements" },
    { role: "assistant", content: "", tool_calls: [{ function: { name: "worktree_read", arguments: { path: "app.tsx" } } }] },
    { role: "tool", tool_name: "worktree_read", content: source },
    { role: "assistant", content: "", tool_calls: [{ function: { name: "worktree_read", arguments: { path: "app.tsx" } } }] },
    { role: "tool", tool_name: "worktree_read", content: source },
    { role: "tool", tool_name: "worktree_read", content: source.replaceAll("original", "changed") },
    { role: "tool", tool_name: "verification_run", content: source },
  ];
  const snapshot = JSON.stringify(messages);
  const result = compactImplementationContext(messages);
  assert.equal(JSON.stringify(messages), snapshot);
  assert.deepEqual(result.slice(0, 4), messages.slice(0, 4));
  assert.equal(result.length, messages.length);
  assert.equal(JSON.parse(result[4].content).redundantObservation, true);
  assert.deepEqual(result.slice(5), messages.slice(5));
  assert.ok(JSON.stringify(result).length < snapshot.length);
});

test("small observations never inflate and accounting reconciles to the actual serialized body", () => {
  const messages: ContextMessage[] = Array.from({ length: 2 }, () => ({ role: "tool", tool_name: "worktree_stat", content: "{}" }));
  assert.deepEqual(compactImplementationContext(messages), messages);
  const tools = [{ function: { name: "read", description: 'Unicode and quotes: \"🤖' } }];
  const body = JSON.stringify({ model: "test", messages, tools, stream: true });
  const result = requestBreakdown(messages, tools, body);
  assert.equal(Object.values(result.characters).reduce((sum, n) => sum + n, 0) + result.toolSchemaCharacters + result.envelopeCharacters, body.length);
});
