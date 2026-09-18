import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessRuntime, findAvailableLoopbackPort, type ProcessRuntimeEvent } from "../packages/process-runtime/src/index.ts";

test("process runtime streams stdout/stderr and records exit evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "borg-process-"));
  const events: ProcessRuntimeEvent[] = [];
  try {
    const runtime = new ProcessRuntime({ onEvent: (event) => events.push(event) });
    const result = await runtime.run({
      taskId: "task-command",
      kind: "test",
      label: "runtime smoke test",
      command: "node",
      args: ["-e", "process.stdout.write('hello\\n'); process.stderr.write('warning\\n')"],
      cwd: root,
      timeoutMs: 10_000,
    });

    assert.equal(result.status, "completed");
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /hello/);
    assert.match(result.stderr, /warning/);
    assert.ok(events.some((event) => event.type === "process.started"));
    assert.ok(events.some((event) => event.type === "process.output" && event.stream === "stdout"));
    assert.ok(events.some((event) => event.type === "process.output" && event.stream === "stderr"));
    assert.ok(events.some((event) => event.type === "process.state" && event.process.status === "completed"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("process runtime reuses one task dev server and supports explicit stop", async () => {
  const root = mkdtempSync(join(tmpdir(), "borg-process-server-"));
  try {
    const runtime = new ProcessRuntime();
    const port = await findAvailableLoopbackPort();
    const url = `http://127.0.0.1:${port}`;
    const args = ["-e", `require('http').createServer((req,res)=>res.end('ok')).listen(${port},'127.0.0.1')`];

    const first = await runtime.ensureServer({
      taskId: "task-server",
      kind: "dev_server",
      label: "preview",
      command: "node",
      args,
      cwd: root,
      url,
      startupTimeoutMs: 10_000,
    });
    const second = await runtime.ensureServer({
      taskId: "task-server",
      kind: "dev_server",
      label: "preview",
      command: "node",
      args,
      cwd: root,
      url,
      startupTimeoutMs: 10_000,
    });

    assert.equal(first.id, second.id);
    assert.equal(runtime.list("task-server").filter((process) => process.status === "running").length, 1);
    const stopped = await runtime.stop(first.id);
    assert.equal(stopped?.status, "stopped");
    assert.equal(runtime.findRunning("task-server", "dev_server"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dev server is not reported running before its URL is ready", async () => {
  const root = mkdtempSync(join(tmpdir(), "borg-process-readiness-"));
  const events: ProcessRuntimeEvent[] = [];
  try {
    const runtime = new ProcessRuntime({ onEvent: (event) => events.push(event) });
    const port = await findAvailableLoopbackPort();
    const url = `http://127.0.0.1:${port}`;
    const ready = await runtime.ensureServer({
      taskId: "readiness", kind: "dev_server", label: "preview", command: "node",
      args: ["-e", `setTimeout(() => require('http').createServer((req,res)=>res.end('ok')).listen(${port},'127.0.0.1'), 300)`],
      cwd: root, url, startupTimeoutMs: 10_000,
    });
    const states = events.filter((event) => event.type === "process.state").map((event) => event.process.status);
    assert.equal(ready.status, "running");
    assert.equal(states.at(-1), "running");
    assert.ok(states.slice(0, -1).every((status) => status === "starting"));
    await runtime.stop(ready.id);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("dev server rejects a URL already served by another process", async () => {
  const root = mkdtempSync(join(tmpdir(), "borg-process-occupied-"));
  const server = createServer((_request, response) => response.end("BORG"));
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const runtime = new ProcessRuntime();
  try {
    await assert.rejects(runtime.ensureServer({
      taskId: "occupied", kind: "dev_server", label: "preview", command: "node",
      args: ["-e", "setTimeout(() => {}, 30000)"], cwd: root,
      url: `http://127.0.0.1:${address.port}`, startupTimeoutMs: 2_000,
    }), /already in use/);
    assert.equal(runtime.findRunning("occupied", "dev_server"), null);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("process runtime cannot stop a different task by task-scoped lookup", async () => {
  const root = mkdtempSync(join(tmpdir(), "borg-process-owner-"));
  try {
    const runtime = new ProcessRuntime();
    const resultPromise = runtime.run({
      taskId: "task-a",
      kind: "command",
      label: "long command",
      command: "node",
      args: ["-e", "setTimeout(() => process.exit(0), 30000)"],
      cwd: root,
      timeoutMs: 35_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const running = runtime.findRunning("task-a");
    assert.ok(running);
    assert.equal(runtime.list("task-b").length, 0);
    await runtime.stop(running!.id);
    const result = await resultPromise;
    assert.equal(result.status, "stopped");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
