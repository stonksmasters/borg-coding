import assert from "node:assert/strict";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BrowserVerification, assertLoopbackUrl, resolveTaskBrowserUrl, routeConsistencyIssue, routeInteractionIssue, routeJourneyIssue, routeQualityIssue } from "../packages/browser-verification/src/index.ts";

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

test("browser navigation uses the task preview origin even when a model guesses the BORG UI port", () => {
  assert.equal(resolveTaskBrowserUrl("http://localhost:5173/music?tab=latest", "http://127.0.0.1:62144/"), "http://127.0.0.1:62144/music?tab=latest");
  assert.throws(() => resolveTaskBrowserUrl("https://example.com", "http://127.0.0.1:62144/"), /loopback/);
});

test("route journeys reject links that render the entry page at a different URL", () => {
  assert.match(routeJourneyIssue({ route: "/products", name: "Products", linked: true, reached: true, renderedDistinctContent: false }) ?? "", /same page content/i);
  assert.match(routeJourneyIssue({ route: "/products", name: "Products", linked: false, reached: false, renderedDistinctContent: false }) ?? "", /No rendered navigation link/i);
  assert.equal(routeJourneyIssue({ route: "/products", name: "Products", linked: true, reached: true, renderedDistinctContent: true }), null);
});

test("route quality requires three responsive viewports and clean accessibility", () => {
  const base = { route: "/work", name: "Work", linked: true, reached: true, renderedDistinctContent: true };
  assert.match(routeQualityIssue({ ...base, responsiveViewports: 2, accessibilityPassed: true }) ?? "", /mobile, tablet, and desktop/i);
  assert.match(routeQualityIssue({ ...base, responsiveViewports: 3, accessibilityPassed: false }) ?? "", /accessibility violation/i);
  assert.equal(routeQualityIssue({ ...base, responsiveViewports: 3, accessibilityPassed: true }), null);
});

test("cross-page consistency requires a complete semantic shell, active navigation, and shared typography", () => {
  const rootStyle = { bodyFontFamily: "Inter", bodyColor: "rgb(20, 20, 20)", headingFontFamily: "Newsreader" };
  const base = {
    route: "/work", name: "Work", activeNavigation: true,
    landmarks: { header: true, navigation: true, main: true, footer: true },
    styleSignature: rootStyle,
  };
  assert.equal(routeConsistencyIssue(base, rootStyle), null);
  assert.match(routeConsistencyIssue({ ...base, landmarks: { ...base.landmarks, footer: false } }, rootStyle) ?? "", /footer/i);
  assert.match(routeConsistencyIssue({ ...base, activeNavigation: false }, rootStyle) ?? "", /aria-current/i);
  assert.match(routeConsistencyIssue({ ...base, styleSignature: { ...rootStyle, bodyFontFamily: "Arial" } }, rootStyle) ?? "", /typography/i);
});

test("route interaction evidence reports unusable controls", () => {
  assert.equal(routeInteractionIssue({ route: "/contact", name: "Contact", interactionIssues: [] }), null);
  assert.match(routeInteractionIssue({ route: "/contact", name: "Contact", interactionIssues: ["form has no submit control"] }) ?? "", /form has no submit control/i);
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
    }, context) as { running: boolean; url: string; pid: number | null };
    assert.equal(started.running, true);
    assert.equal(started.url, `${url}/`);
    assert.equal(runtime.latest(context.taskId)?.passed, false);
    assert.match(runtime.latest(context.taskId)?.issues.join(" ") ?? "", /DOM evidence/);
    assert.match(runtime.latest(context.taskId)?.issues.join(" ") ?? "", /screenshot evidence/);
    const response = await fetch(url);
    assert.equal(await response.text(), "ready");

    const reused = await runtime.execute("browser_server_start", { command: "npm", args: ["run", "dev"], url: "http://localhost:5173" }, context) as { running: boolean; url: string; pid: number | null };
    assert.equal(reused.url, `${url}/`);
    assert.equal(reused.pid, started.pid);
    assert.equal((await fetch(url)).status, 200);

    const stopped = await runtime.execute("browser_server_stop", {}, context) as { stopped: boolean };
    assert.equal(stopped.stopped, true);
  } finally {
    await runtime.execute("browser_server_stop", {}, context);
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});


test("managed preview receives project environment without exposing the value in server evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "borg-browser-env-"));
  const port = await availablePort();
  const secret = "preview-secret-value";
  const runtime = new BrowserVerification({
    environmentForTask: (taskId): Record<string, string> => taskId === "browser-env-test" ? { PROJECT_SECRET: secret } : {},
  });
  const context = { taskId: "browser-env-test", worktreePath: root };
  const url = `http://127.0.0.1:${port}`;
  try {
    const started = await runtime.execute("browser_server_start", {
      command: "node",
      args: ["-e", `console.log(process.env.PROJECT_SECRET); require('node:http').createServer((_, response) => response.end(process.env.PROJECT_SECRET || 'missing')).listen(${port}, '127.0.0.1')`],
      url,
      timeout_seconds: 10,
    }, context) as { stdout: string; stderr: string };

    const response = await fetch(url);
    assert.equal(await response.text(), secret);
    assert.equal(started.stdout.includes(secret), false);
    assert.equal(started.stderr.includes(secret), false);
  } finally {
    await runtime.execute("browser_server_stop", {}, context);
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("managed development servers allocate a fresh port when the requested URL is occupied", async () => {
  const root = mkdtempSync(join(tmpdir(), "borg-browser-port-"));
  const occupiedServer = createHttpServer((_request, response) => response.end("occupied"));
  await new Promise<void>((resolveListen) => occupiedServer.listen(0, "127.0.0.1", resolveListen));
  const address = occupiedServer.address();
  const occupiedPort = typeof address === "object" && address ? address.port : 0;
  const runtime = new BrowserVerification();
  const context = { taskId: "browser-port-test", worktreePath: root };
  try {
    const started = await runtime.execute("browser_server_start", {
      command: "node",
      args: ["-e", "require('node:http').createServer((_, response) => response.end('managed')).listen(Number(process.env.PORT), '127.0.0.1')"],
      url: `http://127.0.0.1:${occupiedPort}`,
      timeout_seconds: 10,
    }, context) as { running: boolean; url: string };

    assert.equal(started.running, true);
    assert.notEqual(new URL(started.url).port, String(occupiedPort));
    assert.equal(await (await fetch(started.url)).text(), "managed");
  } finally {
    await runtime.execute("browser_server_stop", {}, context);
    await new Promise<void>((resolveClose) => occupiedServer.close(() => resolveClose()));
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
