import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const remoteEntry = resolve(repositoryRoot, "apps", "server", "src", "remote-gateway.ts");

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => resolveBody(body));
    request.on("error", reject);
  });
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to allocate test port.");
  const port = address.port;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
}

async function waitFor(url: string, child: ChildProcess, stderr: () => string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Remote gateway exited early: ${stderr()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // keep polling
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Timed out waiting for ${url}. stderr: ${stderr()}`);
}

test("LAN remote pairs devices and proxies only the bounded BORG control surface", async (t) => {
  const gatewayPort = await freePort();
  const remotePort = await freePort();
  const receivedChat: { value: Record<string, unknown> | null } = { value: null };
  const receivedApproval: { value: Record<string, unknown> | null } = { value: null };

  const gateway = createServer((request, response) => {
    const url = request.url ?? "/";
    response.setHeader("content-type", "application/json");

    if (request.method === "GET" && url === "/health") {
      response.end(JSON.stringify({ status: "ok", gateway: true }));
      return;
    }
    if (request.method === "GET" && url === "/api/sessions") {
      response.end(JSON.stringify({
        sessions: [{
          id: "session-1",
          title: "Remote fixture",
          activeMode: "agent",
          parentSessionId: null,
          workflowRole: "primary",
        }],
      }));
      return;
    }
    if (request.method === "GET" && url === "/api/sessions/session-1") {
      response.end(JSON.stringify({
        session: { id: "session-1", title: "Remote fixture", activeMode: "agent" },
        latestTaskId: "task-1",
        task: { id: "task-1", state: "AWAITING_APPROVAL" },
        approval: { id: "approval-1", taskId: "task-1", status: "REQUESTED" },
        projectPlanApproval: false,
        runtimeActive: false,
        messages: [{ id: "message-1", role: "assistant", kind: "plan", text: "Fixture plan" }],
      }));
      return;
    }
    if (request.method === "POST" && url === "/api/sessions/session-1/stop") {
      response.end(JSON.stringify({ stopped: true, sessionId: "session-1" }));
      return;
    }
    if (request.method === "GET" && url === "/api/tasks/task-1/workflow-status") {
      response.end(JSON.stringify({
        status: {
          taskId: "task-1",
          taskState: "AWAITING_APPROVAL",
          status: "waiting",
          phase: "frontend",
          sliceIndex: 0,
          sliceTotal: 3,
          sliceTitle: "Hero",
          nextAction: "approve",
        },
      }));
      return;
    }
    if (request.method === "GET" && url === "/api/control/tasks/task-1/snapshot") {
      response.end(JSON.stringify({
        snapshot: {
          version: 1,
          task: { id: "task-1", state: "AWAITING_APPROVAL" },
          diagnostics: [{ id: "control_plane.consistent", severity: "info", title: "Consistent", evidence: "Fixture" }],
          events: [],
        },
      }));
      return;
    }
    if (request.method === "POST" && url === "/api/tasks/task-1/approval") {
      void readBody(request).then((body) => {
        receivedApproval.value = JSON.parse(body) as Record<string, unknown>;
        response.end(JSON.stringify({ approval: { status: "APPROVED" } }));
      });
      return;
    }
    if (request.method === "POST" && url === "/api/tasks/task-1/retry") {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.end(JSON.stringify({ type: "task.state", state: "IMPLEMENTING" }) + "\n");
      return;
    }
    if (request.method === "POST" && url === "/api/chat") {
      void readBody(request).then((body) => {
        receivedChat.value = JSON.parse(body) as Record<string, unknown>;
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        response.end([
          JSON.stringify({ type: "task.created", task: { id: "task-2" } }),
          JSON.stringify({ type: "stream.completed", taskId: "task-2" }),
          "",
        ].join("\n"));
      });
      return;
    }

    response.writeHead(404);
    response.end(JSON.stringify({ error: "fixture route not found" }));
  });

  await new Promise<void>((resolveListen) => gateway.listen(gatewayPort, "127.0.0.1", resolveListen));
  t.after(() => new Promise<void>((resolveClose) => gateway.close(() => resolveClose())));

  let stderr = "";
  const child = spawn(process.execPath, ["--experimental-strip-types", remoteEntry], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      BORG_REMOTE_PORT: String(remotePort),
      BORG_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`,
      BORG_REMOTE_PAIRING_CODE: "123456",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    if (child.exitCode === null) await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  });

  const base = `http://127.0.0.1:${remotePort}`;
  await waitFor(`${base}/health`, child, () => stderr);

  const shell = await fetch(base);
  assert.equal(shell.status, 200);
  assert.match(await shell.text(), /BORG Remote/);

  const localInfo = await fetch(`${base}/api/local-info`);
  assert.equal(localInfo.status, 200);
  const localBody = await localInfo.json() as { pairingCode: string; port: number };
  assert.equal(localBody.pairingCode, "123456");
  assert.equal(localBody.port, remotePort);

  const unauthorized = await fetch(`${base}/api/remote/sessions`);
  assert.equal(unauthorized.status, 401);

  const badPair = await fetch(`${base}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "000000" }),
  });
  assert.equal(badPair.status, 401);

  const pair = await fetch(`${base}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "123456" }),
  });
  assert.equal(pair.status, 200);
  const cookie = pair.headers.get("set-cookie");
  assert.ok(cookie);
  const auth = { cookie: cookie.split(";")[0] };

  const sessions = await fetch(`${base}/api/remote/sessions`, { headers: auth });
  assert.equal(sessions.status, 200);
  const sessionsBody = await sessions.json() as { sessions: Array<{ id: string }> };
  assert.deepEqual(sessionsBody.sessions.map((session) => session.id), ["session-1"]);

  const runtime = await fetch(`${base}/api/remote/sessions/session-1`, { headers: auth });
  assert.equal(runtime.status, 200);
  assert.equal((await runtime.json() as { latestTaskId: string }).latestTaskId, "task-1");

  const workflow = await fetch(`${base}/api/remote/tasks/task-1/workflow-status`, { headers: auth });
  assert.equal(workflow.status, 200);
  assert.equal((await workflow.json() as { status: { sliceTotal: number } }).status.sliceTotal, 3);

  const debug = await fetch(`${base}/api/remote/tasks/task-1/debug`, { headers: auth });
  assert.equal(debug.status, 200);
  assert.equal((await debug.json() as { snapshot: { task: { id: string } } }).snapshot.task.id, "task-1");

  const approval = await fetch(`${base}/api/remote/tasks/task-1/approval`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ decision: "approve" }),
  });
  assert.equal(approval.status, 200);
  assert.equal(receivedApproval.value?.decision, "approve");

  const stop = await fetch(`${base}/api/remote/sessions/session-1/stop`, { method: "POST", headers: auth });
  assert.equal(stop.status, 200);
  assert.equal((await stop.json() as { stopped: boolean }).stopped, true);

  const chat = await fetch(`${base}/api/remote/chat`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "session-1", request: "Continue from my phone." }),
  });
  assert.equal(chat.status, 200);
  assert.match(await chat.text(), /stream.completed/);
  assert.equal(receivedChat.value?.sessionId, "session-1");

  const disallowed = await fetch(`${base}/api/remote/access`, { headers: auth });
  assert.equal(disallowed.status, 404);
});
