import assert from "node:assert/strict";
import test from "node:test";
import type { ToolBroker } from "../packages/tools/src/tool-broker.ts";
import { modelMessages, parseTextToolCalls, runOllamaAgent } from "../apps/server/src/ollama-agent.ts";

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

test("context trimming prioritizes pinned system contracts over old tool history", () => {
  const system = [
    "GLOBAL PRODUCT CONTRACT",
    "x".repeat(24_000),
    "CURRENT SLICE ACCEPTANCE: mobile navigation works and product hierarchy remains coherent",
  ].join("\n");
  const messages = [
    { role: "system" as const, content: system },
    { role: "user" as const, content: "Build the approved slice " + "u".repeat(12_000) },
    ...Array.from({ length: 6 }, (_, index) => ({ role: "tool" as const, content: `old tool ${index} ${"t".repeat(8_000)}` })),
    { role: "tool" as const, content: "LATEST VERIFICATION EVIDENCE" },
  ];
  const bounded = modelMessages(messages, 40_000);
  assert.ok(JSON.stringify(bounded).length <= 40_000);
  assert.match(bounded[0].content, /GLOBAL PRODUCT CONTRACT/);
  assert.match(bounded[0].content, /CURRENT SLICE ACCEPTANCE/);
  assert.match(bounded.at(-1)?.content ?? "", /LATEST VERIFICATION EVIDENCE/);
});

test("tool budget forces a final synthesis instead of failing the task", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  const capturedBodies: string[] = [];
  const events: Record<string, unknown>[] = [];
  const fakeTools = {
    toolDefinitions: () => [{ type: "function", function: { name: "repository_read", description: "read", parameters: { type: "object" } } }],
    execute: async () => ({ content: "evidence" }),
  } as unknown as ToolBroker;

  globalThis.fetch = async (_input, init) => {
    requests += 1;
    assert.equal(capturedBodies.at(-1), String(init?.body));
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
      onRequestBody: (body) => capturedBodies.push(body),
      messages: [{ role: "user", content: "Inspect the repository" }], emit: (event) => events.push(event),
    });
    assert.equal(result.usedTools, true);
    assert.match(result.answer, /Final plan/);
    assert.equal(requests, 4);
    assert.equal(capturedBodies.length, requests);
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


test("text tool-call markup is parsed for local-model compatibility", () => {
  const calls = parseTextToolCalls(`<function=activity_update>
<parameter=phase>
planning
</parameter>
<parameter=status>
completed
</parameter>
<parameter=title>
Repository Analysis Complete
</parameter>
</function>
</tool_call>`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, "activity_update");
  assert.deepEqual(calls[0].function.arguments, {
    phase: "planning",
    status: "completed",
    title: "Repository Analysis Complete",
  });
});

test("textual tool calls execute and do not become the final architect answer", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  const executions: { name: string; args: Record<string, unknown> }[] = [];
  const events: Record<string, unknown>[] = [];
  const fakeTools = {
    toolDefinitions: () => [{ type: "function", function: { name: "activity_update", description: "status", parameters: { type: "object" } } }],
    execute: async (call: { function: { name: string; arguments: Record<string, unknown> } }) => {
      executions.push({ name: call.function.name, args: call.function.arguments });
      return { acknowledged: true };
    },
  } as unknown as ToolBroker;

  globalThis.fetch = async () => {
    requests += 1;
    const message = requests === 1
      ? { content: `<function=activity_update>
<parameter=phase>
planning
</parameter>
<parameter=status>
completed
</parameter>
<parameter=title>
Repository Analysis Complete
</parameter>
</function>
</tool_call>` }
      : { content: "Final architecture plan with implementation slices." };
    return new Response(`${JSON.stringify({ message })}\n`, { status: 200, headers: { "content-type": "application/x-ndjson" } });
  };

  try {
    const result = await runOllamaAgent({
      ollamaUrl: "http://127.0.0.1:11434",
      model: "test",
      mode: "plan",
      tools: fakeTools,
      messages: [{ role: "user", content: "Plan the application." }],
      streamText: false,
      emit: (event) => events.push(event),
    });
    assert.equal(requests, 2);
    assert.equal(executions.length, 1);
    assert.equal(executions[0].name, "activity_update");
    assert.equal(executions[0].args.title, "Repository Analysis Complete");
    assert.equal(result.usedTools, true);
    assert.match(result.answer, /Final architecture plan/);
    assert.doesNotMatch(result.answer, /<function=/);
    assert.ok(events.some((event) => event.type === "runtime.tool_protocol.recovered"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("tool failures are returned directly for bounded recovery classification", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  const fakeTools = {
    toolDefinitions: () => [{ type: "function", function: { name: "worktree_read", description: "read", parameters: { type: "object" } } }],
    execute: async () => { throw new Error("ENOENT: no such file or directory, realpath src/features/recovery/Missing.tsx"); },
  } as unknown as ToolBroker;

  globalThis.fetch = async () => {
    requests += 1;
    const message = requests === 1
      ? { content: "", tool_calls: [{ function: { name: "worktree_read", arguments: { path: "src/features/recovery/Missing.tsx" } } }] }
      : { content: "Stopping after the failed read." };
    return new Response(`${JSON.stringify({ message })}\n`, { status: 200, headers: { "content-type": "application/x-ndjson" } });
  };

  try {
    const result = await runOllamaAgent({
      ollamaUrl: "http://127.0.0.1:11434",
      model: "test",
      mode: "edit",
      tools: fakeTools,
      messages: [{ role: "user", content: "Inspect the target." }],
      emit: () => {},
    });
    assert.equal(requests, 2);
    assert.deepEqual(result.toolFailures, ["ENOENT: no such file or directory, realpath src/features/recovery/Missing.tsx"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
