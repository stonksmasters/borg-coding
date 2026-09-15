import assert from "node:assert/strict";
import test from "node:test";
import type { ToolBroker } from "../packages/tools/src/tool-broker.ts";
import { runOllamaAgent } from "../apps/server/src/ollama-agent.ts";

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
      messages: [{ role: "user", content: "Inspect the repository" }], emit: (event) => events.push(event),
    });
    assert.equal(result.usedTools, true);
    assert.match(result.answer, /Final plan/);
    assert.equal(requests, 11);
    assert.ok(events.some((event) => event.type === "runtime.notice"));
  } finally { globalThis.fetch = originalFetch; }
});
