import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProcessRuntime, type ProcessRuntimeEvent } from "../packages/process-runtime/src/index.ts";

test("process runtime injects project environment and redacts secret values from snapshots and events", async () => {
  const root = mkdtempSync(join(tmpdir(), "borg-process-env-"));
  const events: ProcessRuntimeEvent[] = [];
  const runtime = new ProcessRuntime({ onEvent: (event) => events.push(event) });
  const secret = "super-secret-runtime-value";
  try {
    const result = await runtime.run({
      taskId: "task-env",
      kind: "command",
      label: "environment test",
      command: "node",
      args: ["-e", "process.stdout.write(process.env.PROJECT_SECRET || 'missing'); process.stderr.write('|' + (process.env.PROJECT_SECRET || 'missing'))"],
      cwd: root,
      env: { PROJECT_SECRET: secret },
      redact: [secret],
      timeoutMs: 10_000,
    });

    assert.equal(result.status, "completed");
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.includes(secret), false);
    assert.equal(result.stderr.includes(secret), false);
    assert.match(result.stdout, /\*\*\*/);
    assert.match(result.stderr, /\*\*\*/);
    const output = events.filter((event) => event.type === "process.output").map((event) => event.type === "process.output" ? event.text : "").join("");
    assert.equal(output.includes(secret), false);
    assert.match(output, /\*\*\*/);
  } finally {
    await runtime.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});
