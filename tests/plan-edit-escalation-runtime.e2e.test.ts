import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coreEntry = join(sourceRoot, "apps", "server", "src", "index.ts");
const gatewayEntry = join(sourceRoot, "apps", "server", "src", "desktop-gateway.ts");
const architectPlan = [
  "Plan:",
  "1. Inspect the approved repository and preserve the committed base.",
  "2. After approval, create hello.txt containing hello world in the isolated worktree.",
  "3. Verify the resulting diff while leaving the base repository untouched.",
].join("\n");

type LoggedChild = {
  process: ChildProcess;
  logs: () => string;
};

function delay(milliseconds: number) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
}

function startNode(entry: string, cwd: string, env: Record<string, string>): LoggedChild {
  let output = "";
  const child = spawn(process.execPath, ["--experimental-strip-types", "--experimental-sqlite", entry], {
    cwd,
    env: { ...process.env, ...env, BORG_DESKTOP_EXE: "", OLLAMA_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  child.stderr?.on("data", (chunk) => { output += String(chunk); });
  return { process: child, logs: () => output };
}

async function stopChild(child: ChildProcess | null) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = once(child, "exit").then(() => true);
  const stoppedGracefully = await Promise.race([
    exited,
    delay(3_000).then(() => false),
  ]);
  if (!stoppedGracefully && child.exitCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit").catch(() => undefined);
  }
}

async function waitForHttp(url: string, child: LoggedChild, label: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.process.exitCode !== null) throw new Error(`${label} exited before becoming ready.\n${child.logs()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Startup race; retry below.
    }
    await delay(50);
  }
  throw new Error(`${label} did not become ready.\n${child.logs()}`);
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  assert.equal(response.ok, true, `Request failed (${response.status}): ${body.error ?? url}`);
  return body;
}

async function ndjsonRequest(url: string, init?: RequestInit): Promise<Record<string, unknown>[]> {
  const response = await fetch(url, init);
  assert.equal(response.ok, true, `NDJSON request failed (${response.status}).`);
  const text = await response.text();
  return text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function startFakeOllama(
  implementerPrompts: string[],
): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/api/tags") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ models: [{ name: "fake-model" }] }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/chat") {
      response.writeHead(404).end();
      return;
    }

    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const input = JSON.parse(body) as {
        messages?: Array<{ role?: string; content?: string; tool_name?: string }>;
      };
      const messages = input.messages ?? [];
      const system = messages.find((message) => message.role === "system")?.content ?? "";
      const user = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
      const hasPatchResult = messages.some((message) => message.role === "tool" && message.tool_name === "worktree_patch");

      let message: Record<string, unknown>;
      if (system.includes("BORG's approved implementation agent")) {
        implementerPrompts.push(user);
        if (user.includes("bounded repair attempt")) {
          message = { role: "assistant", content: "No additional mutation is appropriate for the verifier-only failure." };
        } else if (!hasPatchResult) {
          message = {
            role: "assistant",
            content: "",
            tool_calls: [{
              function: {
                name: "worktree_patch",
                arguments: { path: "hello.txt", old_text: "", new_text: "hello world" },
              },
            }],
          };
        } else {
          message = { role: "assistant", content: "The approved worktree mutation is complete." };
        }
      } else if (system.includes("BORG's Architect")) {
        message = { role: "assistant", content: architectPlan };
      } else {
        message = { role: "assistant", content: "No findings." };
      }

      response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8" });
      response.end(`${JSON.stringify({ message })}\n`);
    });
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const port = (server.address() as AddressInfo).port;
  return { server, url: `http://127.0.0.1:${port}` };
}

test("PLAN escalation survives gateway restart and approval resumes the persisted plan in an isolated worktree", { timeout: 45_000 }, async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "borg-plan-edit-e2e-"));
  const repositoryPath = join(runtimeRoot, "fixture-repo");
  const databasePath = join(runtimeRoot, ".borg", "borg.db");
  const implementerPrompts: string[] = [];
  let core: LoggedChild | null = null;
  let gateway: LoggedChild | null = null;
  let fakeOllama: { server: Server; url: string } | null = null;

  try {
    mkdirSync(repositoryPath, { recursive: true });
    writeFileSync(join(repositoryPath, "README.md"), "# PLAN escalation fixture\n", "utf8");
    execFileSync("git", ["init", "-q"], { cwd: repositoryPath });
    execFileSync("git", ["add", "README.md"], { cwd: repositoryPath });
    execFileSync("git", ["-c", "user.name=BORG Test", "-c", "user.email=borg@example.test", "commit", "-q", "-m", "initial"], { cwd: repositoryPath });

    fakeOllama = await startFakeOllama(implementerPrompts);
    const corePort = await reservePort();
    const gatewayPort = await reservePort();
    const commonEnv = {
      BORG_DATABASE_PATH: databasePath,
      BORG_MODEL: "fake-model",
      BORG_OLLAMA_URL: fakeOllama.url,
    };

    core = startNode(coreEntry, runtimeRoot, { ...commonEnv, BORG_PORT: String(corePort) });
    await waitForHttp(`http://127.0.0.1:${corePort}/health`, core, "core");
    gateway = startNode(gatewayEntry, runtimeRoot, {
      ...commonEnv,
      BORG_GATEWAY_PORT: String(gatewayPort),
      BORG_CORE_URL: `http://127.0.0.1:${corePort}`,
    });
    await waitForHttp(`http://127.0.0.1:${gatewayPort}/health`, gateway, "gateway");

    const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
    await jsonRequest(`${gatewayUrl}/api/access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repositoryPath, documents: [] }),
    });
    const created = await jsonRequest<{ session: { id: string; activeMode: string } }>(`${gatewayUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ activeMode: "plan" }),
    });
    assert.equal(created.session.activeMode, "plan");

    const planningEvents = await ndjsonRequest(`${gatewayUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: created.session.id, request: "Create hello.txt containing hello world." }),
    });
    const taskCreated = planningEvents.find((event) => event.type === "task.created") as { task?: { id?: string } } | undefined;
    const taskId = taskCreated?.task?.id;
    assert.ok(taskId, "planning stream should create a task");
    const escalations = planningEvents.filter((event) => event.type === "mode.escalation.requested");
    assert.equal(
      escalations.length,
      1,
      `PLAN should emit exactly one canonical escalation event. Events: ${JSON.stringify(planningEvents)}\nCore: ${core.logs()}\nGateway: ${gateway.logs()}`,
    );
    assert.equal(planningEvents.some((event) => event.type === "task.state" && event.state === "AWAITING_APPROVAL"), true);
    assert.equal(planningEvents.some((event) => event.type === "task.state" && event.state === "COMPLETE"), false);
    assert.equal(existsSync(join(repositoryPath, "hello.txt")), false, "PLAN must not mutate the base repository");

    const beforeRestart = await jsonRequest<{
      session: { activeMode: string };
      task: { id: string; state: string } | null;
      approval: { status: string } | null;
      escalation: { taskId: string; planText: string } | null;
      runtimeAvailable: boolean;
    }>(`${gatewayUrl}/api/sessions/${created.session.id}`);
    assert.equal(beforeRestart.session.activeMode, "plan");
    assert.equal(beforeRestart.task?.state, "AWAITING_APPROVAL");
    assert.equal(beforeRestart.approval?.status, "REQUESTED");
    assert.equal(beforeRestart.escalation?.taskId, taskId);
    assert.equal(beforeRestart.escalation?.planText, architectPlan);
    assert.equal(beforeRestart.runtimeAvailable, true);

    await stopChild(gateway.process);
    gateway = startNode(gatewayEntry, runtimeRoot, {
      ...commonEnv,
      BORG_GATEWAY_PORT: String(gatewayPort),
      BORG_CORE_URL: `http://127.0.0.1:${corePort}`,
    });
    await waitForHttp(`http://127.0.0.1:${gatewayPort}/health`, gateway, "restarted gateway");

    const restored = await jsonRequest<{
      session: { activeMode: string };
      task: { state: string } | null;
      approval: { status: string } | null;
      escalation: { taskId: string; planText: string } | null;
    }>(`${gatewayUrl}/api/sessions/${created.session.id}`);
    assert.equal(restored.session.activeMode, "plan");
    assert.equal(restored.task?.state, "AWAITING_APPROVAL");
    assert.equal(restored.approval?.status, "REQUESTED");
    assert.equal(restored.escalation?.taskId, taskId);
    assert.equal(restored.escalation?.planText, architectPlan);

    const approved = await jsonRequest<{
      session: { activeMode: string };
      task: { state: string };
      approval: { status: string; worktreePath: string | null; baseCommit: string | null };
      worktree?: { path?: string };
    }>(`${gatewayUrl}/api/tasks/${taskId}/approval`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    assert.equal(approved.session.activeMode, "edit");
    assert.equal(approved.task.state, "IMPLEMENTING");
    assert.equal(approved.approval.status, "APPROVED");
    assert.ok(approved.approval.worktreePath);
    assert.ok(approved.approval.baseCommit);
    assert.equal(existsSync(join(approved.approval.worktreePath!, "hello.txt")), false);

    const afterApproval = await jsonRequest<{
      session: { activeMode: string };
      task: { state: string } | null;
      approval: { status: string } | null;
      escalation: unknown;
    }>(`${gatewayUrl}/api/sessions/${created.session.id}`);
    assert.equal(afterApproval.session.activeMode, "edit");
    assert.equal(afterApproval.task?.state, "IMPLEMENTING");
    assert.equal(afterApproval.approval?.status, "APPROVED");
    assert.equal(afterApproval.escalation, null);

    const executionEvents = await ndjsonRequest(`${gatewayUrl}/api/tasks/${taskId}/execute`, { method: "POST" });
    const patchEvent = executionEvents.find((event) => event.type === "tool.completed" && event.tool === "worktree_patch") as {
      output?: { path?: string; created?: boolean };
    } | undefined;
    assert.ok(patchEvent, "approved execution should perform a real worktree_patch mutation");
    assert.equal(patchEvent.output?.path, "hello.txt");
    assert.equal(patchEvent.output?.created, true);
    assert.equal(readFileSync(join(approved.approval.worktreePath!, "hello.txt"), "utf8"), "hello world");
    assert.equal(existsSync(join(repositoryPath, "hello.txt")), false, "the committed base repository must remain untouched");
    assert.ok(
      implementerPrompts.some((prompt) => prompt.includes(`Approved plan:\n${architectPlan}`)),
      "implementation must resume from the persisted architect plan instead of re-planning",
    );
  } finally {
    await stopChild(gateway?.process ?? null);
    await stopChild(core?.process ?? null);
    if (fakeOllama) await new Promise<void>((resolveClose) => fakeOllama!.server.close(() => resolveClose()));
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
