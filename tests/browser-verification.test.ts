import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BrowserVerification, assertLoopbackUrl } from "../packages/browser-verification/src/index.ts";

async function availablePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to reserve a test port."));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

test("browser verification accepts only loopback application URLs", () => {
  assert.equal(assertLoopbackUrl("http://127.0.0.1:5173/app").hostname, "127.0.0.1");
  assert.equal(assertLoopbackUrl("https://localhost:3000").hostname, "localhost");
  assert.throws(() => assertLoopbackUrl("https://example.com"), /loopback/);
  assert.throws(() => assertLoopbackUrl("file:///tmp/index.html"), /local HTTP/);
  assert.throws(() => assertLoopbackUrl("http://user:pass@localhost:3000"), /credentials/);
});

test("browser tools expose the complete evidence workflow", () => {
  const names = new BrowserVerification().definitions().map((tool) => tool.function.name);
  assert.deepEqual(names, [
    "browser_server_start",
    "browser_server_stop",
    "browser_open",
    "browser_dom",
    "browser_interact",
    "browser_capture",
    "browser_responsive",
    "browser_close",
  ]);
});

test("managed development servers stay bounded to the approved worktree", async () => {
  const root = mkdtempSync(join(tmpdir(), "borg-browser-"));
  const port = await availablePort();
  const runtime = new BrowserVerification();
  const context = { taskId: "browser-server-test", worktreePath: root };
  const url = `http://127.0.0.1:${port}`;
  try {
    const started = await runtime.execute("browser_server_start", {
      command: "node",
      args: ["-e", `require('node:http').createServer((_, response) => response.end('ready')).listen(${port}, '127.0.0.1')`],
      url,
      timeout_seconds: 10,
    }, context) as { running: boolean; url: string };
    assert.equal(started.running, true);
    assert.equal(started.url, `${url}/`);
    const response = await fetch(url);
    assert.equal(await response.text(), "ready");

    const stopped = await runtime.execute("browser_server_stop", {}, context) as { stopped: boolean };
    assert.equal(stopped.stopped, true);
  } finally {
    await runtime.execute("browser_server_stop", {}, context);
    rmSync(root, { recursive: true, force: true });
  }
});
