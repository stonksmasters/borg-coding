import assert from "node:assert/strict";
import test from "node:test";
import type { ToolBroker } from "../packages/tools/src/tool-broker.ts";
import { modelMessages, runOllamaAgent } from "../apps/server/src/ollama-agent.ts";

test("retry context is smaller even when pinned messages are oversized", () => {
  const messages = [
    { role: "system" as const, content: "s".repeat(100_000) },
    { role: "user" as const, content: "u".repeat(40_000) },
    { role: "tool" as const, content: "latest evidence " + "e".repeat(40_000) },
  ];
  const first = modelMessages(messages, 40_000);
  const retry = modelMessages(messages, 18_000);
  assert.ok(JSON.stringify(first).length <= 40_000);
  assert.ok(JSON.stringify(retry).length <= 18_000);
  assert.ok(JSON.stringify(retry).length < JSON.stringify(first).length);
  assert.match(retry.at(-1)?.content ?? "", /latest evidence/);
});

test("tool budget forces a final synthesis instead of failing the task", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  const events: Record<string, unknown>[] = [];
  const fakeTools = {
    toolDefinitions: () => [{ type: "function", function: { name: "repository_read", description: "read", parameters: { type: "object" } } }],
    execute: async () => ({ content: "evidence" }),
  } as unknown as ToolBroker;

  globalThis.fetch = async (_input, init) => {
    requests += 1;
    const body = JSON.parse(String(init?.body)) as { tools?: unknown[] };
    const message = body.tools?.length
      ? { content: "", tool_calls: [{ function: { name: "repository_read", arguments: { path: `file-${requests}.ts` } } }] }
      : { content: "Final plan from collected evidence." };
    return new Response(`${JSON.stringify({ message })}\n`, { status: 200, headers: { "content-type": "application/x-ndjson" } });
  };

  try {
    const result = await runOllamaAgent({
      ollamaUrl: "http://127.0.0.1:11434", model: "test", mode: "plan", tools: fakeTools,
      limits: { toolRounds: 3 },
      messages: [{ role: "user", content: "Inspect the repository" }], emit: (event) => events.push(event),
    });
    assert.equal(result.usedTools, true);
    assert.match(result.answer, /Final plan/);
    assert.equal(requests, 4);
    assert.ok(events.some((event) => event.type === "runtime.notice"));
  } finally { globalThis.fetch = originalFetch; }
});

test("a terminated model turn retries without repeating completed tools", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  let executions = 0;
  const events: Record<string, unknown>[] = [];
  const fakeTools = {
    toolDefinitions: () => [{ type: "function", function: { name: "worktree_read", description: "read", parameters: { type: "object" } } }],
    execute: async () => { executions += 1; return { content: "saved evidence" }; },
  } as unknown as ToolBroker;
  globalThis.fetch = async () => {
    requests += 1;
    const message = requests === 1
      ? { content: "", tool_calls: [{ function: { name: "worktree_read", arguments: { path: "src/App.tsx" } } }] }
      : { content: "Done using the saved evidence." };
    return new Response(`${JSON.stringify(requests === 2 ? { error: "terminated" } : { message })}\n`, { status: 200 });
  };
  try {
    const result = await runOllamaAgent({
      ollamaUrl: "http://127.0.0.1:11434", model: "test", mode: "edit", tools: fakeTools,
      messages: [{ role: "user", content: "Inspect" }], emit: (event) => events.push(event),
    });
    assert.equal(requests, 3);
    assert.equal(executions, 1);
    assert.match(result.answer, /saved evidence/);
    assert.ok(events.some((event) => event.type === "runtime.turn.retrying"));
  } finally { globalThis.fetch = originalFetch; }
});

test("model requests bound old tool history while retaining the latest result", async () => {
  const originalFetch = globalThis.fetch;
  let sentMessages: { role: string; content: string }[] = [];
  globalThis.fetch = async (_input, init) => {
    sentMessages = (JSON.parse(String(init?.body)) as { messages: typeof sentMessages }).messages;
    return new Response(`${JSON.stringify({ message: { content: "Done" } })}\n`, { status: 200 });
  };
  const fakeTools = { toolDefinitions: () => [] } as unknown as ToolBroker;
  try {
    const messages = [
      { role: "system" as const, content: "system" },
      { role: "user" as const, content: "request" },
      ...Array.from({ length: 8 }, (_, index) => [
        { role: "assistant" as const, content: `read ${index}` },
        { role: "tool" as const, content: `result ${index} ${"x".repeat(20_000)}`, tool_name: "worktree_read" },
      ]).flat(),
    ];
    await runOllamaAgent({ ollamaUrl: "http://127.0.0.1:11434", model: "test", mode: "edit", tools: fakeTools, messages, emit: () => {} });
    assert.ok(JSON.stringify(sentMessages).length < 90_000);
    assert.match(sentMessages.at(-1)?.content ?? "", /result 7/);
    assert.ok(sentMessages.some((message) => message.content.includes("omitted")));
  } finally { globalThis.fetch = originalFetch; }
});

test("a model turn that already streamed text does not retry and duplicate it", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  const events: Record<string, unknown>[] = [];
  globalThis.fetch = async () => {
    requests += 1;
    return new Response(`${JSON.stringify({ message: { content: "partial" } })}\n${JSON.stringify({ error: "terminated" })}\n`, { status: 200 });
  };
  const fakeTools = { toolDefinitions: () => [] } as unknown as ToolBroker;
  try {
    await assert.rejects(() => runOllamaAgent({
      ollamaUrl: "http://127.0.0.1:11434", model: "test", mode: "edit", tools: fakeTools,
      messages: [{ role: "user", content: "Build" }], emit: (event) => events.push(event),
    }), /terminated/);
    assert.equal(requests, 1);
    assert.equal(events.filter((event) => event.type === "message.delta").length, 1);
  } finally { globalThis.fetch = originalFetch; }
});
