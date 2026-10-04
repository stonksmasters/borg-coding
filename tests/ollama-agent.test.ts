import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import type { ToolBroker } from "../packages/tools/src/tool-broker.ts";
import { modelMessages, ollamaInferenceOptions, parseTextToolCalls, runOllamaAgent } from "../apps/server/src/ollama-agent.ts";

test("unchanged reads reuse a durable receipt and stalled implementation returns without extra synthesis", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  let conditionalReads = 0;
  let records = 0;
  const bodies: string[] = [];
  const events: Record<string, unknown>[] = [];
  globalThis.fetch = async (_url, init) => {
    requests++;
    bodies.push(String(init?.body));
    return new Response(JSON.stringify({ done: true, message: { content: "", tool_calls: [{ function: { name: "worktree_read", arguments: { path: "src/App.tsx" } } }] } }));
  };
  try {
    const result = await runOllamaAgent({
      ollamaUrl: "http://localhost:11434", model: "test", phase: "implementation", mode: "agent", messages: [{ role: "user", content: "fix" }],
      limits: { identicalCalls: 5 },
      tools: { toolDefinitions: () => ["worktree_read", "worktree_observation_read"].map((name) => ({ type: "function", function: { name } })),
        execute: async (call: { function: { arguments: { known_sha256?: string } } }) => {
          if (call.function.arguments.known_sha256 === "a".repeat(64)) { conditionalReads++; return { notModified: true, sha256: "a".repeat(64) }; }
          return { path: "src/App.tsx", sha256: "a".repeat(64), content: "exact source" };
        },
      } as unknown as ToolBroker,
      recordObservation: (tool, output) => ({ id: String(++records), tool, sha256: "b".repeat(64), characters: JSON.stringify(output).length }),
      emit: (event) => events.push(event),
    });
    assert.equal(requests, 4);
    assert.equal(conditionalReads, 3);
    assert.equal(records, 1);
    assert.equal(result.budgetExhausted, false);
    assert.ok(bodies.at(-1)!.includes("currentHashVerified"));
    assert.ok(events.some((event) => event.type === "runtime.context.stalled"));
  } finally { globalThis.fetch = originalFetch; }
});

test("implementation continues under pressure using persisted receipts without losing recent source", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const events: Record<string, unknown>[] = [];
  let calls = 0;
  let saved = 0;
  globalThis.fetch = async (_url, init) => {
    const body = String(init?.body);
    assert.ok(body.length <= 8_000);
    bodies.push(JSON.parse(body));
    calls += 1;
    return new Response(JSON.stringify({ done: true, message: calls <= 4
      ? { content: "", tool_calls: [{ function: { name: "worktree_read", arguments: { path: `${calls}.tsx` } } }] }
      : { content: "Ready for verification" } }));
  };
  const tools = {
    toolDefinitions: () => ["worktree_read", "worktree_observation_read"].map((name) => ({ type: "function", function: { name, parameters: { type: "object" } } })),
    execute: async (call: { function: { arguments: { path: string } } }) => ({ path: call.function.arguments.path, content: call.function.arguments.path.repeat(420) }),
  } as unknown as ToolBroker;
  try {
    const result = await runOllamaAgent({
      ollamaUrl: "http://localhost:11434", model: "test", mode: "agent", phase: "implementation", tools, maxRequestCharacters: 8_000,
      messages: [{ role: "system", content: "approved design" }, { role: "user", content: "exact request" }],
      recordObservation: (tool, output) => {
        const serialized = JSON.stringify(output);
        return { id: String(++saved), tool, characters: serialized.length, sha256: createHash("sha256").update(serialized).digest("hex") };
      }, emit: (event) => events.push(event),
    });
    assert.equal(result.answer, "Ready for verification");
    assert.equal(saved, 4);
    assert.ok(events.some((event) => event.type === "runtime.context.rebuilt"));
    const last = bodies.at(-1)!.messages;
    assert.equal(last[0].content, "approved design");
    assert.equal(last[1].content, "exact request");
    assert.ok(last.some((message) => message.content.includes("archivedObservation")));
    assert.ok(last.at(-1)!.content.includes("4.tsx".repeat(420)));
  } finally { globalThis.fetch = originalFetch; }
});

test("implementation accounts for tool schemas and rejects capacity before inference without trimming authority", async () => {
  const originalFetch = globalThis.fetch;
  const events: Record<string, unknown>[] = [];
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; throw new Error("unexpected fetch"); };
  const messages = [{ role: "system" as const, content: "approved contract" }, { role: "user" as const, content: "exact requirements" }];
  try {
    await assert.rejects(() => runOllamaAgent({
      ollamaUrl: "http://localhost:11434", model: "test", mode: "agent", phase: "implementation", maxRequestCharacters: 8_000,
      tools: { toolDefinitions: () => [{ type: "function", function: { name: "read", description: "x".repeat(9_000) } }] } as unknown as ToolBroker,
      messages, emit: (event) => events.push(event),
    }), /CONTEXT_CAPACITY_EXCEEDED/);
    assert.equal(fetched, false);
    assert.equal(messages[0].content, "approved contract");
    const accounting = events.find((event) => event.type === "runtime.context.accounted")!;
    assert.equal(accounting.accepted, false);
    assert.ok(Number(accounting.toolSchemaCharacters) > 9_000);
  } finally { globalThis.fetch = originalFetch; }
});

test("inference metrics use Ollama counts and parse the final chunk without a newline", async () => {
  const originalFetch = globalThis.fetch;
  const events: Record<string, unknown>[] = [];
  globalThis.fetch = async () => new Response(JSON.stringify({ message: { content: "Done" }, done: true, prompt_eval_count: 123, eval_count: 7, prompt_eval_duration: 2_000_000, eval_duration: 3_000_000 }));
  try {
    const result = await runOllamaAgent({
      ollamaUrl: "http://localhost:11434", model: "test", mode: "agent", phase: "implementation", allowTools: false,
      tools: {} as ToolBroker, messages: [{ role: "user", content: "task" }], emit: (event) => events.push(event),
    });
    assert.equal(result.answer, "Done");
    const metrics = events.find((event) => event.type === "runtime.inference.measured")!;
    assert.equal(metrics.promptTokens, 123);
    assert.equal(metrics.generatedTokens, 7);
    assert.equal(metrics.promptEvaluationMs, 2);
    assert.equal(metrics.generationMs, 3);
    assert.equal(metrics.loadMs, null);
    assert.equal(metrics.totalMs, null);
  } finally { globalThis.fetch = originalFetch; }
});

test("Devstral inference is bounded for consumer GPU planning", () => {
  assert.deepEqual(ollamaInferenceOptions("devstral-small-2:latest"), {
    temperature: 0.2,
    num_ctx: 16_384,
    num_predict: 2_048,
  });
  assert.equal(ollamaInferenceOptions("qwen3-coder:30b"), undefined);
});

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


test("tool-free planning never exposes tools and respects the stage request budget", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody = "";
  const fakeTools = {
    toolDefinitions: () => { throw new Error("tool definitions must not be requested"); },
  } as unknown as ToolBroker;

  globalThis.fetch = async (_input, init) => {
    requestBody = String(init?.body ?? "");
    const parsed = JSON.parse(requestBody) as { tools?: unknown[]; messages?: Array<{ content?: string }> };
    assert.deepEqual(parsed.tools, []);
    return new Response(`${JSON.stringify({ message: { content: "<borg-product-map>{\"siteGoal\":\"x\"}</borg-product-map>" } })}\n`, {
      status: 200,
      headers: { "content-type": "application/x-ndjson" },
    });
  };

  try {
    const result = await runOllamaAgent({
      ollamaUrl: "http://127.0.0.1:11434",
      model: "test",
      mode: "plan",
      tools: fakeTools,
      allowTools: false,
      maxRequestCharacters: 16_000,
      messages: [
        { role: "system", content: "contract " + "x".repeat(30_000) },
        { role: "user", content: "produce the artifact" },
      ],
      emit: () => {},
    });
    assert.equal(result.usedTools, false);
    assert.ok(requestBody.length <= 17_500, `request body exceeded bounded planner envelope: ${requestBody.length}`);
    assert.match(result.answer, /borg-product-map/);
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test("a tool-free planning turn can retry after a transient streamed failure", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  const events: Record<string, unknown>[] = [];
  globalThis.fetch = async () => {
    requests += 1;
    if (requests === 1) {
      return new Response(`${JSON.stringify({ message: { content: "partial" } })}\n${JSON.stringify({ error: "terminated" })}\n`, { status: 200 });
    }
    return new Response(`${JSON.stringify({ message: { content: "complete plan" } })}\n`, { status: 200 });
  };
  const fakeTools = { toolDefinitions: () => [] } as unknown as ToolBroker;
  try {
    const result = await runOllamaAgent({
      ollamaUrl: "http://127.0.0.1:11434", model: "test", mode: "plan", tools: fakeTools,
      allowTools: false, streamText: false,
      messages: [{ role: "user", content: "Plan" }], emit: (event) => events.push(event),
    });
    assert.equal(requests, 2);
    assert.equal(result.answer, "complete plan");
    assert.ok(events.some((event) => event.type === "runtime.turn.retrying"));
  } finally { globalThis.fetch = originalFetch; }
});

test("a bounded planning turn preserves substantial text when Ollama terminates at the response cap", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  const partialPlan = `Architecture\n${"component and slice details\n".repeat(30)}`;
  const events: Record<string, unknown>[] = [];
  globalThis.fetch = async () => {
    requests += 1;
    return new Response(`${JSON.stringify({ message: { content: partialPlan } })}\n${JSON.stringify({ error: "terminated" })}\n`, { status: 200 });
  };
  const fakeTools = { toolDefinitions: () => [] } as unknown as ToolBroker;
  try {
    const result = await runOllamaAgent({
      ollamaUrl: "http://127.0.0.1:11434", model: "test", mode: "plan", tools: fakeTools,
      phase: "plan", messages: [{ role: "user", content: "Plan" }], emit: (event) => events.push(event),
    });
    assert.equal(requests, 1);
    assert.equal(result.answer, partialPlan);
    assert.ok(events.some((event) => event.type === "runtime.turn.truncated"));
  } finally { globalThis.fetch = originalFetch; }
});

test("a malformed streamed tool call is retried before it can block implementation", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  const events: Record<string, unknown>[] = [];
  globalThis.fetch = async () => {
    requests += 1;
    if (requests === 1) {
      return new Response(`${JSON.stringify({ error: "XML syntax error on line 18: element <function> closed by </parameter>" })}\n`, { status: 200 });
    }
    return new Response(`${JSON.stringify({ message: { content: "Implementation complete." } })}\n`, { status: 200 });
  };
  const fakeTools = { toolDefinitions: () => [] } as unknown as ToolBroker;
  try {
    const result = await runOllamaAgent({
      ollamaUrl: "http://127.0.0.1:11434", model: "test", mode: "agent", tools: fakeTools,
      phase: "implementation", messages: [{ role: "user", content: "Implement the slice." }],
      emit: (event) => events.push(event),
    });
    assert.equal(requests, 2);
    assert.equal(result.answer, "Implementation complete.");
    assert.ok(events.some((event) => event.type === "runtime.tool_protocol.retrying"));
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
