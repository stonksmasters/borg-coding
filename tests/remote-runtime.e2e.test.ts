import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createChatSession } from "../packages/core/src/chat-session.ts";
import { createApproval, createTask, type Task, type WorkflowProjectPlan } from "../packages/core/src/contracts.ts";
import { WorkflowEngine } from "../packages/core/src/workflow-engine.ts";
import { SqliteChatRepository } from "../packages/persistence/src/sqlite-chat-repository.ts";
import { SqliteTaskRepository } from "../packages/persistence/src/sqlite-task-repository.ts";
import { persistProposedProjectPlan } from "../packages/web-builder/src/slice-docs.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coreEntry = join(root, "apps", "server", "src", "index.ts");
const desktopEntry = join(root, "apps", "server", "src", "desktop-gateway.ts");
const remoteEntry = join(root, "apps", "server", "src", "remote-gateway.ts");

type LoggedChild = { process: ChildProcess; logs: () => string };

function delay(ms: number) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }

async function reservePort() {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
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

async function stopChild(child: LoggedChild | undefined) {
  if (!child || child.process.exitCode !== null) return;
  child.process.kill("SIGTERM");
  const exited = once(child.process, "exit").then(() => true);
  if (!await Promise.race([exited, delay(2_000).then(() => false)])) {
    child.process.kill("SIGKILL");
    await once(child.process, "exit").catch(() => undefined);
  }
}

async function waitForHttp(url: string, child: LoggedChild) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.process.exitCode !== null) throw new Error(`Service exited during startup.\n${child.logs()}`);
    try { if ((await fetch(url)).ok) return; } catch { /* startup race */ }
    await delay(50);
  }
  throw new Error(`Service did not become ready: ${url}\n${child.logs()}`);
}

function plan(): WorkflowProjectPlan {
  return {
    version: 2, revision: 1, status: "proposed", phase: "frontend", siteGoal: "Test remote authority",
    audience: "Operators", pages: ["Home"], features: ["Remote control"],
    sitemap: [{ id: "home", name: "Home", route: "/", purpose: "Test", sections: ["Hero"], componentIds: [], acceptanceCriteria: ["Reachable"] }],
    components: [],
    styles: { direction: "Simple", colors: [], typography: [], spacing: [], radii: [], shadows: [], layoutPrinciples: [], motion: [], responsive: [], accessibility: [], avoid: [] },
    visualDirection: "Simple", backendRequired: false,
    slices: [{ id: "first", title: "First", outcome: "Works", scope: ["Home"], acceptanceCriteria: ["Works"] }],
    acceptanceCriteria: ["Remote control works"], proposedAt: new Date().toISOString(), approvedAt: null,
  };
}

function seedApproval(repository: SqliteTaskRepository, projectId: string, taskId: string, repositoryPath: string) {
  const engine = new WorkflowEngine(repository);
  let task = createTask({ id: taskId, projectId, request: "Plan the fixture" });
  engine.start(task, "project_plan");
  task = engine.transition(task, "CLASSIFYING").task;
  task = engine.transition(task, "DISCOVERING").task;
  task = engine.transition(task, "PLANNING").task;
  engine.setProjectPlan(task, plan());
  const approval = createApproval({ id: `approval-${taskId}`, taskId });
  const awaiting = engine.requestApproval(task, approval, "project_plan").task;
  repository.appendEvent({ id: `binding-${taskId}`, taskId, type: "TASK_REPOSITORY_BOUND", payload: { repositoryPath }, occurredAt: new Date().toISOString() });
  repository.appendEvent({ id: `plan-${taskId}`, taskId, type: "PROJECT_PLAN_PROPOSED", payload: { revision: 1 }, occurredAt: new Date().toISOString() });
  return awaiting;
}

function seedBlockedTask(repository: SqliteTaskRepository, projectId: string, taskId: string, repositoryPath: string, worktreePath: string, baseCommit: string) {
  const engine = new WorkflowEngine(repository);
  let task = createTask({ id: taskId, projectId, request: "Retry this bounded task" });
  engine.start(task, "general");
  task = engine.transition(task, "CLASSIFYING").task;
  task = engine.transition(task, "DISCOVERING").task;
  task = engine.transition(task, "PLANNING").task;
  const approval = createApproval({ id: `approval-${taskId}`, taskId });
  task = engine.requestApproval(task, approval, "execution").task;
  task = engine.decideApproval(task, { ...approval, status: "APPROVED", decidedAt: new Date().toISOString(), worktreePath, baseCommit }, "execution").task;
  task = engine.transition(task, "BLOCKED").task;
  repository.appendEvent({ id: `binding-${taskId}`, taskId, type: "TASK_REPOSITORY_BOUND", payload: { repositoryPath }, occurredAt: new Date().toISOString() });
  return task;
}

async function startFakeOllama() {
  let holdRequests = false;
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/api/tags") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ models: [{ name: "fake-model" }] }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/chat") {
      let body = "";
      request.on("data", (chunk) => { body += String(chunk); });
      request.on("end", () => {
        const finish = () => {
          response.writeHead(200, { "content-type": "application/x-ndjson" });
          response.end(`${JSON.stringify({ message: { role: "assistant", content: "Remote stream reached the model adapter." }, done: true })}\n`);
        };
        if (holdRequests || body.includes("hold the runtime open")) setTimeout(finish, 15_000);
        else finish();
      });
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  return {
    server,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hold: () => { holdRequests = true; },
    release: () => { holdRequests = false; },
  };
}

test("remote web controls reach the real desktop gateway and WorkflowEngine authority", { timeout: 45_000 }, async () => {
  const runtime = mkdtempSync(join(tmpdir(), "borg-remote-e2e-"));
  const databasePath = join(runtime, "borg.db");
  const pairingCode = "246810";
  const children: LoggedChild[] = [];
  let ollama: { server: Server; url: string; hold: () => void; release: () => void } | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const taskRepository = new SqliteTaskRepository(databasePath);
    const chatRepository = new SqliteChatRepository(databasePath);
    const repositoryPath = join(runtime, "fixture-repository");
    mkdirSync(repositoryPath, { recursive: true });
    writeFileSync(join(repositoryPath, "README.md"), "# Remote E2E fixture\n");
    writeFileSync(join(repositoryPath, ".borg-website.json"), JSON.stringify({
      name: "Remote E2E", slug: "remote-e2e", framework: "vite-react", template: "portfolio",
      status: "ready", originalBrief: "Test remote authority", createdAt: new Date().toISOString(),
    }, null, 2));
    persistProposedProjectPlan(repositoryPath, "Test remote authority", plan(), "fixture-plan");
    execFileSync("git", ["init", "-q"], { cwd: repositoryPath });
    execFileSync("git", ["add", "."], { cwd: repositoryPath });
    execFileSync("git", ["-c", "user.name=BORG Test", "-c", "user.email=borg@example.test", "commit", "-q", "-m", "fixture"], { cwd: repositoryPath });
    const retryRepositoryPath = join(runtime, "retry-repository");
    mkdirSync(retryRepositoryPath, { recursive: true });
    writeFileSync(join(retryRepositoryPath, "README.md"), "# Retry E2E fixture\n");
    execFileSync("git", ["init", "-q"], { cwd: retryRepositoryPath });
    execFileSync("git", ["add", "."], { cwd: retryRepositoryPath });
    execFileSync("git", ["-c", "user.name=BORG Test", "-c", "user.email=borg@example.test", "commit", "-q", "-m", "fixture"], { cwd: retryRepositoryPath });
    const retryBaseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: retryRepositoryPath, encoding: "utf8" }).trim();
    const retryWorktreePath = join(runtime, ".borg", "worktrees", "retry-task");
    mkdirSync(dirname(retryWorktreePath), { recursive: true });
    execFileSync("git", ["worktree", "add", "-q", "--detach", retryWorktreePath, retryBaseCommit], { cwd: retryRepositoryPath });
    for (const fixture of [
      { sessionId: "approve-session", projectId: "approve-project", taskId: "approve-task", title: "Approve fixture" },
      { sessionId: "reject-session", projectId: "reject-project", taskId: "reject-task", title: "Reject fixture" },
    ]) {
      chatRepository.saveSession(createChatSession({ id: fixture.sessionId, title: fixture.title, activeMode: "plan", repositoryPath, workspaceId: fixture.projectId, model: "fake-model" }));
      seedApproval(taskRepository, fixture.projectId, fixture.taskId, repositoryPath);
      chatRepository.bindTask(fixture.sessionId, fixture.taskId);
    }
    chatRepository.saveSession(createChatSession({ id: "retry-session", title: "Retry fixture", activeMode: "edit", repositoryPath: retryRepositoryPath, workspaceId: "retry-project", model: "fake-model" }));
    seedBlockedTask(taskRepository, "retry-project", "retry-task", retryRepositoryPath, retryWorktreePath, retryBaseCommit);
    chatRepository.bindTask("retry-session", "retry-task");
    chatRepository.saveSession(createChatSession({ id: "chat-session", title: "Chat fixture", activeMode: "ask", workspaceId: "chat-project", model: "fake-model" }));
    chatRepository.close();
    taskRepository.close();

    ollama = await startFakeOllama();
    const [corePort, desktopPort, remotePort] = await Promise.all([reservePort(), reservePort(), reservePort()]);
    const core = startNode(coreEntry, runtime, { BORG_PORT: String(corePort), BORG_DATABASE_PATH: databasePath, BORG_OLLAMA_URL: ollama.url, BORG_MODEL: "fake-model" });
    children.push(core);
    await waitForHttp(`http://127.0.0.1:${corePort}/health`, core);
    const desktop = startNode(desktopEntry, runtime, { BORG_GATEWAY_PORT: String(desktopPort), BORG_CORE_URL: `http://127.0.0.1:${corePort}`, BORG_DATABASE_PATH: databasePath, BORG_MODEL: "fake-model" });
    children.push(desktop);
    await waitForHttp(`http://127.0.0.1:${desktopPort}/health`, desktop);
    const remote = startNode(remoteEntry, runtime, { BORG_REMOTE_PORT: String(remotePort), BORG_GATEWAY_URL: `http://127.0.0.1:${desktopPort}`, BORG_REMOTE_PAIRING_CODE: pairingCode });
    children.push(remote);
    const remoteUrl = `http://127.0.0.1:${remotePort}`;
    await waitForHttp(`${remoteUrl}/`, remote);

    const channel = process.env.BORG_BROWSER_CHANNEL ?? (process.platform === "win32" ? "msedge" : "chrome");
    browser = await chromium.launch({ headless: true, channel });
    const browserContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await browserContext.newPage();
    await page.goto(remoteUrl);
    assert.equal(await page.locator("#commandStatus").getAttribute("data-state"), "idle");
    await page.locator("#pairCode").fill("000000");
    await page.locator("#pairForm button[type=submit]").click();
    await page.locator('#commandStatus[data-state="failed"]').waitFor();
    await page.locator("#pairCode").fill(pairingCode);
    await page.locator("#pairForm button[type=submit]").click();
    await assert.doesNotReject(page.locator("#app:not(.hidden)").waitFor());
    await page.locator('#commandStatus[data-state="accepted"]').waitFor();

    await page.getByRole("button", { name: "Chat fixture" }).click();
    await page.locator('#workspaceTabs button[data-tab="chat"]').click();
    await page.locator("#messageInput").fill("Can the remote client stream a reply?");
    await page.locator("#sendButton").click();
    await page.getByText("Remote stream reached the model adapter.").waitFor({ timeout: 10_000 });
    await page.getByText("Response received.", { exact: true }).waitFor();
    const persistedChats = new SqliteChatRepository(databasePath);
    assert.ok(persistedChats.listMessages("chat-session").some((message) => message.text.includes("Remote stream reached")));
    persistedChats.close();

    await page.getByRole("button", { name: "Approve fixture" }).click();
    await page.locator("#activeSessionTitle").getByText("Approve fixture", { exact: true }).waitFor();
    await page.locator("#taskId").getByText("approve-task", { exact: true }).waitFor();
    await page.locator("#approvalCard:not(.hidden)").waitFor();
    const approvalResponse = page.waitForResponse((response) => response.url().includes("/api/remote/tasks/approve-task/approval"));
    await page.locator("#approveButton").click();
    const approvalHttp = await approvalResponse;
    const approvalBody = await approvalHttp.text();
    assert.equal(approvalHttp.ok(), true, `Approval request failed (${approvalHttp.status()}): ${approvalBody}`);
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const probe = new SqliteTaskRepository(databasePath);
      const state = probe.findTask("approve-task")?.state;
      probe.close();
      if (state && state !== "AWAITING_APPROVAL") break;
      if (attempt === 119) assert.fail(`Approval did not reach Core authority; latest state was ${state}.`);
      await delay(100);
    }
    let authority = new SqliteTaskRepository(databasePath);
    const approvedTask: Task | null = authority.findTask("approve-task");
    assert.equal(approvedTask?.state, "COMPLETE");
    assert.equal(authority.findApproval("approve-task")?.status, "APPROVED");
    const startedWorkflow = authority.findWorkflow("approve-project");
    assert.ok(["plan", "await_approval"].includes(startedWorkflow?.nextAction ?? ""));
    assert.equal(startedWorkflow?.projectPlan?.status, "approved");
    authority.close();
    const startedChats = new SqliteChatRepository(databasePath);
    const sliceTaskId = startedChats.latestTaskId("approve-session");
    startedChats.close();
    assert.ok(sliceTaskId && sliceTaskId !== "approve-task", "approving the plan must start a separately tracked slice task");
    await page.locator("#approvalCard:not(.hidden)").waitFor({ timeout: 10_000 });
    await page.locator("#approveButton").click();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const probe = new SqliteTaskRepository(databasePath);
      const state = probe.findTask(sliceTaskId)?.state;
      probe.close();
      if (state && state !== "AWAITING_APPROVAL") break;
      if (attempt === 99) assert.fail("Execution approval did not start the authoritative slice task.");
      await delay(100);
    }
    await page.getByRole("button", { name: "Chat fixture" }).click();
    await page.locator("#activeSessionTitle").getByText("Chat fixture", { exact: true }).waitFor();

    ollama.hold();
    await page.locator("#messageInput").fill("hold the runtime open");
    await page.locator("#sendButton").click();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const runtimeState = await fetch(`http://127.0.0.1:${desktopPort}/api/sessions/chat-session`).then((response) => response.json()) as { runtimeActive?: boolean };
      if (runtimeState.runtimeActive) break;
      if (attempt === 49) assert.fail("Desktop gateway never reported the held chat runtime as active.");
      await delay(100);
    }
    const controlPage = await page.context().newPage();
    await controlPage.goto(remoteUrl);
    await controlPage.getByText("Runtime active").waitFor({ timeout: 5_000 });
    await controlPage.locator("#messageInput").fill("Stop after this slice and preserve the current result.");
    await controlPage.locator("#sendButton").click();
    await controlPage.locator("#commandMessage").getByText("Instruction queued", { exact: false }).waitFor();
    assert.equal(await controlPage.locator("#commandStatus").getAttribute("data-state"), "accepted");
    const instructionAuthority = new SqliteTaskRepository(databasePath);
    const queued = instructionAuthority.listInstructions({ projectId: "chat-project" });
    assert.equal(queued.length, 1);
    assert.equal(queued[0]?.status, "pending");
    instructionAuthority.close();
    await controlPage.locator("#stopButton").click();
    await controlPage.getByText("Runtime idle").waitFor({ timeout: 5_000 });
    await controlPage.getByText("Stop accepted.", { exact: true }).waitFor();
    const stoppedChats = new SqliteChatRepository(databasePath);
    assert.ok(stoppedChats.listMessages("chat-session").some((message) => message.text.includes("Runtime stop requested")));
    stoppedChats.close();

    await controlPage.getByRole("button", { name: "Reject fixture" }).click();
    await controlPage.locator("#activeSessionTitle").getByText("Reject fixture", { exact: true }).waitFor();
    await controlPage.locator("#approvalCard:not(.hidden)").waitFor();
    await controlPage.locator("#rejectButton").click();
    await controlPage.waitForFunction(() => document.querySelector("#approvalCard")?.classList.contains("hidden"));
    await controlPage.getByText("Rejection accepted.", { exact: true }).waitFor();
    authority = new SqliteTaskRepository(databasePath);
    assert.equal(authority.findTask("reject-task")?.state, "CANCELLED");
    assert.equal(authority.findApproval("reject-task")?.status, "REJECTED");
    authority.close();

    await controlPage.getByRole("button", { name: "Retry fixture" }).click();
    await controlPage.locator("#activeSessionTitle").getByText("Retry fixture", { exact: true }).waitFor();
    await controlPage.locator("#retryButton:not(.hidden)").waitFor();
    const retryTaskId = "retry-task";
    const retryBefore = new SqliteTaskRepository(databasePath);
    const attemptsBefore = retryBefore.findTask(retryTaskId)?.attempts ?? 0;
    const eventsBefore = retryBefore.listEvents(retryTaskId).length;
    assert.equal(retryBefore.findTask(retryTaskId)?.state, "BLOCKED");
    retryBefore.close();
    ollama.release();
    const retryPage = await page.context().newPage();
    await retryPage.goto(remoteUrl);
    await retryPage.locator("#activeSessionTitle").getByText("Retry fixture", { exact: true }).waitFor();
    await retryPage.locator("#taskId").getByText("retry-task", { exact: true }).waitFor();
    const retryResponse = retryPage.waitForResponse((response) => response.url().includes("/api/remote/tasks/retry-task/retry"));
    await retryPage.locator("#retryButton:not(.hidden)").click();
    const retryHttp = await retryResponse;
    assert.equal(retryHttp.ok(), true, `Retry request failed (${retryHttp.status()}).`);
    await delay(500);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const probe = new SqliteTaskRepository(databasePath);
      const retried = probe.findTask(retryTaskId);
      const eventCount = probe.listEvents(retryTaskId).length;
      probe.close();
      if ((retried?.attempts ?? 0) > attemptsBefore || retried?.state !== "BLOCKED" || eventCount > eventsBefore) break;
      if (attempt === 99) {
        const activity = await retryPage.locator("#activity").innerText();
        assert.fail(`Retry did not change the blocked task's authoritative state. Remote activity: ${activity}`);
      }
      await delay(100);
    }

  } finally {
    await browser?.close().catch(() => undefined);
    for (const child of children.reverse()) await stopChild(child);
    if (ollama) await new Promise<void>((resolveClose) => ollama!.server.close(() => resolveClose()));
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { rmSync(runtime, { recursive: true, force: true }); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
        await delay(100);
      }
    }
  }
});
