import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createChatSession } from "../packages/core/src/chat-session.ts";
import { SqliteChatRepository } from "../packages/persistence/src/sqlite-chat-repository.ts";

async function readJson(request: IncomingMessage) {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return body.trim() ? JSON.parse(body) as Record<string, unknown> : {};
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function ndjson(response: ServerResponse, events: Record<string, unknown>[]) {
  response.writeHead(200, { "content-type": "application/x-ndjson" });
  response.end(events.map((event) => JSON.stringify(event)).join("\n") + "\n");
}

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not expose a TCP port.");
  return address.port;
}

async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("Timed out waiting for frontend workflow integration condition.");
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
    new Promise<void>((resolveExit) => setTimeout(resolveExit, 2_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

test("approving a frontend plan server-side starts slice 1, mutates source, and checkpoints it", async () => {
  const root = mkdtempSync(join(tmpdir(), "borg-frontend-orchestrator-"));
  const website = join(root, "website");
  const src = join(website, "src");
  const databasePath = join(root, "state", "borg.db");
  mkdirSync(src, { recursive: true });
  mkdirSync(dirname(databasePath), { recursive: true });
  writeFileSync(join(src, "App.tsx"), "export default function App(){return <main>Starter</main>}\n", "utf8");

  const chats = new SqliteChatRepository(databasePath);
  const parent = createChatSession({
    id: "plan-session",
    title: "Integration Site",
    activeMode: "plan",
    repositoryPath: website,
    workspaceId: "integration-site",
    provider: "ollama",
    model: "test-model",
  });
  chats.saveSession(parent);
  chats.bindTask(parent.id, "plan-task");
  chats.close();

  let sliceState = "AWAITING_APPROVAL";
  let deliveryCalls = 0;
  let chatRequest: Record<string, unknown> | null = null;

  const core = createServer((request, response) => {
    void (async () => {
      const url = request.url ?? "/";
      if (request.method === "POST" && url === "/api/tools") return json(response, 200, { tools: {} });
      if (request.method === "GET" && url === "/health") return json(response, 200, { status: "ok", runtimeConnected: true, modelAvailable: true });

      if (request.method === "POST" && url === "/api/tasks/plan-task/approval") {
        await readJson(request);
        return json(response, 200, {
          projectPlanApproved: true,
          task: { id: "plan-task", state: "COMPLETE" },
          approval: { id: "plan-approval", taskId: "plan-task", status: "APPROVED", worktreePath: null, baseCommit: null },
        });
      }

      if (request.method === "POST" && url === "/api/chat") {
        chatRequest = await readJson(request);
        return ndjson(response, [
          { type: "task.created", task: { id: "slice-task", request: "slice 1", state: "PLANNING" } },
          { type: "message.delta", text: "Implement the approved first slice." },
          { type: "approval.requested", approval: { id: "slice-approval", taskId: "slice-task", status: "REQUESTED", worktreePath: null, baseCommit: null } },
          { type: "stream.completed", taskId: "slice-task" },
        ]);
      }

      if (request.method === "POST" && url === "/api/tasks/slice-task/approval") {
        await readJson(request);
        sliceState = "IMPLEMENTING";
        return json(response, 200, {
          task: { id: "slice-task", state: sliceState },
          approval: { id: "slice-approval", taskId: "slice-task", status: "APPROVED", worktreePath: join(root, "worktree"), baseCommit: "base" },
        });
      }

      if (request.method === "POST" && url === "/api/tasks/slice-task/execute") {
        writeFileSync(join(src, "App.tsx"), "export default function App(){return <main>Slice 1 built</main>}\n", "utf8");
        sliceState = "DELIVERY_READY";
        return ndjson(response, [
          { type: "mode.authorized", taskId: "slice-task", mode: "edit" },
          { type: "implementation.summary", taskId: "slice-task", status: { stdout: " M src/App.tsx" } },
          { type: "delivery.ready", taskId: "slice-task" },
          { type: "stream.completed", taskId: "slice-task" },
        ]);
      }

      if (request.method === "GET" && url === "/api/tasks/slice-task/approval") {
        return json(response, 200, {
          task: { id: "slice-task", state: sliceState },
          approval: { id: "slice-approval", taskId: "slice-task", status: "APPROVED", worktreePath: join(root, "worktree"), baseCommit: "base" },
        });
      }

      if (request.method === "POST" && url === "/api/tasks/slice-task/delivery") {
        await readJson(request);
        deliveryCalls += 1;
        sliceState = "COMPLETE";
        return json(response, 200, { task: { id: "slice-task", state: "COMPLETE" }, delivery: { commit: "checkpoint-commit" } });
      }

      return json(response, 404, { error: `Unhandled fake-core route ${request.method} ${url}` });
    })().catch((error) => json(response, 500, { error: error instanceof Error ? error.message : String(error) }));
  });

  let gateway: ChildProcess | null = null;
  try {
    const corePort = await listen(core);
    const gatewayPort = await freePort();
    const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    gateway = spawn(process.execPath, [
      "--experimental-strip-types",
      "--experimental-sqlite",
      join(repositoryRoot, "apps", "server", "src", "desktop-gateway.ts"),
    ], {
      cwd: root,
      env: {
        ...process.env,
        BORG_GATEWAY_PORT: String(gatewayPort),
        BORG_CORE_URL: `http://127.0.0.1:${corePort}`,
        BORG_DATABASE_PATH: databasePath,
      },
      stdio: "ignore",
    });

    await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${gatewayPort}/health`);
        return response.ok;
      } catch {
        return false;
      }
    });

    const approval = await fetch(`http://127.0.0.1:${gatewayPort}/api/tasks/plan-task/approval`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    const approvalBody = await approval.json() as { workflowStarted?: boolean; startedSession?: { activeMode?: string } };
    assert.equal(approval.status, 200);
    assert.equal(approvalBody.workflowStarted, true);
    assert.equal(approvalBody.startedSession?.activeMode, "edit");

    await waitFor(() => deliveryCalls === 1);
    assert.equal((chatRequest as Record<string, unknown> | null)?.mode, "edit");
    assert.equal((chatRequest as Record<string, unknown> | null)?.sliceAction, "initial");
    assert.match(readFileSync(join(src, "App.tsx"), "utf8"), /Slice 1 built/);
    assert.equal(deliveryCalls, 1);
  } finally {
    if (gateway) await stopChild(gateway);
    await new Promise<void>((resolveClose) => core.close(() => resolveClose()));
    rmSync(root, { recursive: true, force: true });
  }
});
