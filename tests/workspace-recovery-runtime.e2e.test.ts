import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTask, WorkflowStateSchema } from "../packages/core/src/contracts.ts";
import { SqliteTaskRepository } from "../packages/persistence/src/sqlite-task-repository.ts";
import { approveProjectPlan, fallbackProjectPlan, persistProposedProjectPlan, prepareSlice, readProjectPlan } from "../packages/web-builder/src/slice-docs.ts";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coreEntry = join(sourceRoot, "apps", "server", "src", "index.ts");

type LoggedChild = { process: ChildProcess; logs: () => string };

function delay(milliseconds: number) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function reservePort() {
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
  const graceful = await Promise.race([exited, delay(3_000).then(() => false)]);
  if (!graceful && child.exitCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit").catch(() => undefined);
  }
}

async function waitForHttp(url: string, child: LoggedChild) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.process.exitCode !== null) throw new Error(`Core exited before becoming ready.\n${child.logs()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // startup race
    }
    await delay(50);
  }
  throw new Error(`Core did not become ready.\n${child.logs()}`);
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  assert.equal(response.ok, true, `Request failed (${response.status}): ${body.error ?? url}`);
  return body;
}

async function ndjsonRequest(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  assert.equal(response.ok, true, `NDJSON request failed (${response.status}).`);
  const body = await response.text();
  return body.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as Record<string, unknown>);
}

type FailureMode = "recoverable_missing_path" | "fatal_path_escape";

async function startFakeOllama(mode: FailureMode, implementerPrompts: string[]) {
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
    request.on("data", (chunk) => { body += String(chunk); });
    request.on("end", () => {
      const input = JSON.parse(body) as {
        messages?: Array<{ role?: string; content?: string; tool_name?: string }>;
      };
      const messages = input.messages ?? [];
      const system = messages.filter((message) => message.role === "system").map((message) => message.content ?? "").join("\n\n");
      const user = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
      const hasReadResult = messages.some((message) => message.role === "tool" && message.tool_name === "worktree_read");
      const hasWriteResult = messages.some((message) => message.role === "tool" && message.tool_name === "worktree_write");

      let message: Record<string, unknown>;
      if (system.includes("fresh-context code reviewer")) {
        message = {
          role: "assistant",
          content: JSON.stringify({
            verdict: "pass",
            summary: "Verified recovery change is scoped and correct.",
            criteria: [
              { criterion: "hero communicates the primary offer", verdict: "pass", evidence: "The fixture's approved recovery path preserves the first-slice implementation contract." },
              { criterion: "desktop and mobile layouts are usable", verdict: "pass", evidence: "Deterministic verification and the fixture contract report the responsive slice as usable." },
              { criterion: "visible navigation controls work", verdict: "pass", evidence: "The scoped fixture introduces no broken navigation control and verification passes." },
            ],
            findings: [],
          }),
        };
      } else if (system.includes("BORG's approved implementation agent")) {
        implementerPrompts.push(user);
        const recovering = user.includes("RECOVERY:");
        if (mode === "fatal_path_escape") {
          if (hasWriteResult) message = { role: "assistant", content: "Unexpected successful unsafe write." };
          else {
            message = {
              role: "assistant",
              content: "",
              tool_calls: [{ function: { name: "worktree_write", arguments: { path: "../../escape.ts", content: "escape\n" } } }],
            };
          }
        } else if (!recovering) {
          if (hasReadResult) message = { role: "assistant", content: "The target file is missing; stopping this attempt without inventing a new plan." };
          else {
            message = {
              role: "assistant",
              content: "",
              tool_calls: [{ function: { name: "worktree_read", arguments: { path: "src/features/recovery/Missing.tsx" } } }],
            };
          }
        } else if (!hasWriteResult) {
          message = {
            role: "assistant",
            content: "",
            tool_calls: [{
              function: {
                name: "worktree_write",
                arguments: {
                  path: "src/features/recovery/Recovered.tsx",
                  content: "export function Recovered(){ return <section>Recovered slice</section>; }\n",
                },
              },
            }],
          };
        } else {
          message = { role: "assistant", content: "Recovered the current approved slice without re-planning." };
        }
      } else {
        message = { role: "assistant", content: JSON.stringify({ verdict: "pass", summary: "No findings.", findings: [] }) };
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

function createWebsiteRepository(runtimeRoot: string, taskId: string) {
  const repositoryPath = join(runtimeRoot, "website");
  mkdirSync(join(repositoryPath, "src"), { recursive: true });
  writeFileSync(join(repositoryPath, "src", "App.tsx"), "export default function App(){return <main>Fixture</main>}\n");
  writeFileSync(join(repositoryPath, "package.json"), JSON.stringify({
    name: "recovery-fixture",
    private: true,
    scripts: {
      dev: "node -e \"process.exit(0)\"",
      build: "node -e \"process.exit(0)\"",
      check: "node -e \"process.exit(0)\"",
    },
    dependencies: { react: "19.2.0" },
    devDependencies: { vite: "8.0.0" },
  }, null, 2));
  writeFileSync(join(repositoryPath, ".borg-website.json"), JSON.stringify({
    name: "Recovery Fixture",
    slug: "recovery-fixture",
    framework: "vite-react",
    template: "portfolio",
    status: "ready",
    originalBrief: "Build a resilient frontend fixture.",
    createdAt: new Date().toISOString(),
  }, null, 2));

  const plan = fallbackProjectPlan("Build a resilient frontend fixture.", "portfolio");
  persistProposedProjectPlan(repositoryPath, "Build a resilient frontend fixture.", plan, "plan-task");
  approveProjectPlan(repositoryPath, "plan-task");
  prepareSlice(repositoryPath, "", "initial", "", taskId, "Implement the approved first slice.");

  execFileSync("git", ["init", "-q"], { cwd: repositoryPath });
  execFileSync("git", ["add", "."], { cwd: repositoryPath });
  execFileSync("git", ["-c", "user.name=BORG Test", "-c", "user.email=borg@example.test", "commit", "-q", "-m", "approved plan"], { cwd: repositoryPath });
  const approvedPlan = readProjectPlan(repositoryPath);
  assert.ok(approvedPlan && approvedPlan.status === "approved", "fixture must persist an approved project plan");
  const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryPath, encoding: "utf8" }).trim();

  const worktreePath = join(runtimeRoot, ".borg", "worktrees", taskId);
  mkdirSync(dirname(worktreePath), { recursive: true });
  execFileSync("git", ["worktree", "add", "-q", "-b", `borg-test-${taskId}`, worktreePath, baseCommit], { cwd: repositoryPath });
  assert.equal(existsSync(join(worktreePath, "src", "features")), false, "empty scaffold directories should not be present in a fresh Git worktree");
  return { repositoryPath, worktreePath, baseCommit, approvedPlan };
}

async function seedApprovedTask(databasePath: string, input: {
  taskId: string;
  worktreePath: string;
  baseCommit: string;
  approvedPlan: NonNullable<ReturnType<typeof readProjectPlan>>;
}) {
  const repository = new SqliteTaskRepository(databasePath);
  const now = new Date().toISOString();
  const task = {
    ...createTask({ id: input.taskId, projectId: "recovery-project", request: "Implement the approved first frontend slice." }),
    state: "IMPLEMENTING" as const,
    disciplines: ["general"],
    updatedAt: now,
  };
  const approval = {
    id: `approval-${input.taskId}`,
    taskId: input.taskId,
    status: "APPROVED" as const,
    requestedAt: now,
    decidedAt: now,
    worktreePath: input.worktreePath,
    baseCommit: input.baseCommit,
  };
  const firstSlice = input.approvedPlan.slices[0];
  const state = WorkflowStateSchema.parse({
    projectId: task.projectId,
    taskId: task.id,
    loop: "slice",
    phase: "frontend",
    status: "running",
    nextAction: "implement",
    planApprovalId: "plan-task",
    planApproved: true,
    projectPlan: input.approvedPlan,
    planRevisionResumeIndex: null,
    sliceIndex: 0,
    sliceTotal: input.approvedPlan.slices.length,
    sliceTitle: firstSlice?.title ?? "Visual foundation and shared primitives",
    feedback: [],
    handoff: null,
    pendingCommand: null,
    lastConsumedCommandId: null,
    verification: {
      status: "pending",
      attempt: 0,
      profile: null,
      summary: "",
      browserPassed: null,
      specialistPassed: null,
      resultSha256: null,
      completedAt: null,
    },
    recovery: {
      status: "inactive",
      category: null,
      previousTaskState: null,
      checkpointId: null,
      resumeAction: "none",
      reason: "",
      updatedAt: null,
    },
    attemptPhase: "implementation",
    designRefinementAttempt: 0,
    repairAttempt: 0,
    recoveryCategory: null,
    detail: "Executing the approved first frontend slice.",
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  repository.commitWorkflowMutation({ state, task, approval, events: [
    { id: `slice-${input.taskId}`, taskId: input.taskId, type: "FRONTEND_SLICE_SELECTED", payload: { action: "initial" }, occurredAt: now },
    { id: `plan-${input.taskId}`, taskId: input.taskId, type: "MODEL_RESPONSE_COMPLETED", payload: { answer: "Use the approved persisted phase plan; do not re-plan." }, occurredAt: now },
  ] });
  repository.close();
}

async function runRuntimeCase(mode: FailureMode) {
  const runtimeRoot = mkdtempSync(join(tmpdir(), `borg-runtime-recovery-${mode}-`));
  const taskId = mode === "recoverable_missing_path" ? "slice-recover" : "slice-fatal";
  const databasePath = join(runtimeRoot, ".borg", "borg.db");
  const prompts: string[] = [];
  let core: LoggedChild | null = null;
  let ollama: { server: Server; url: string } | null = null;
  try {
    const fixture = createWebsiteRepository(runtimeRoot, taskId);
    ollama = await startFakeOllama(mode, prompts);
    const corePort = await reservePort();
    core = startNode(coreEntry, runtimeRoot, {
      BORG_DATABASE_PATH: databasePath,
      BORG_PORT: String(corePort),
      BORG_MODEL: "fake-model",
      BORG_OLLAMA_URL: ollama.url,
      BORG_REVIEW_TIMEOUT_MS: "5000",
    });
    const coreUrl = `http://127.0.0.1:${corePort}`;
    await waitForHttp(`${coreUrl}/health`, core);
    await jsonRequest(`${coreUrl}/api/access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repositoryPath: fixture.repositoryPath, documents: [] }),
    });
    await seedApprovedTask(databasePath, {
      taskId,
      worktreePath: fixture.worktreePath,
      baseCommit: fixture.baseCommit,
      approvedPlan: fixture.approvedPlan,
    });
    const events = await ndjsonRequest(`${coreUrl}/api/tasks/${taskId}/execute`, { method: "POST" });
    return { runtimeRoot, databasePath, prompts, events, fixture, taskId, core, ollama };
  } catch (error) {
    await stopChild(core?.process ?? null);
    if (ollama) await new Promise<void>((resolveClose) => ollama!.server.close(() => resolveClose()));
    rmSync(runtimeRoot, { recursive: true, force: true });
    throw error;
  }
}

async function cleanupRuntime(result: Awaited<ReturnType<typeof runRuntimeCase>>) {
  await stopChild(result.core?.process ?? null);
  if (result.ollama) await new Promise<void>((resolveClose) => result.ollama!.server.close(() => resolveClose()));
  rmSync(result.runtimeRoot, { recursive: true, force: true });
}

test("approved slice recovers from a missing target, verifies, and reaches its checkpoint without re-planning", { timeout: 45_000 }, async () => {
  const result = await runRuntimeCase("recoverable_missing_path");
  try {
    assert.ok(result.events.some((event) => event.type === "workspace.preflight.completed"));
    assert.ok(
      result.events.some((event) => event.type === "recovery.scheduled" && event.category === "missing_path"),
      `Expected missing_path recovery. Events: ${JSON.stringify(result.events)}`,
    );
    assert.ok(result.events.some((event) => event.type === "tool.completed" && event.tool === "worktree_write"));
    assert.ok(result.events.some((event) => event.type === "delivery.ready"));
    assert.equal(readFileSync(join(result.fixture.worktreePath, "src", "features", "recovery", "Recovered.tsx"), "utf8").includes("Recovered slice"), true);
    assert.equal(existsSync(join(result.fixture.repositoryPath, "src", "features", "recovery", "Recovered.tsx")), false, "base repository must remain untouched");
    assert.ok(result.prompts.length >= 2);
    assert.equal(result.prompts[0].includes("RECOVERY:"), false);
    assert.ok(result.prompts.some((prompt) => prompt.includes("RECOVERY: missing_path")));
    assert.ok(result.prompts.some((prompt) => prompt.includes("SAME approved slice")));
    assert.equal(result.prompts.some((prompt) => /rediscover the whole repository/i.test(prompt)), false);

    const repository = new SqliteTaskRepository(result.databasePath);
    const task = repository.findTask(result.taskId);
    const persistedEvents = repository.listEvents(result.taskId);
    const checkpoints = repository.listCheckpoints(result.taskId);
    assert.equal(task?.state, "DELIVERY_READY");
    assert.ok(persistedEvents.some((event) => event.type === "FRONTEND_SLICE_READY"));
    assert.ok(persistedEvents.some((event) => event.type === "IMPLEMENTATION_RECOVERY_SCHEDULED"));
    const preflights = persistedEvents.filter((event) => event.type === "WORKSPACE_PREFLIGHT_COMPLETED");
    assert.ok(preflights.length >= 2);
    assert.ok(preflights.some((event) => {
      const report = event.payload.report as { repairedDirectories?: string[] };
      return report.repairedDirectories?.includes("src/features");
    }));
    assert.ok(checkpoints.some((checkpoint) => checkpoint.kind === "pre_delivery"));
    repository.close();
  } finally {
    await cleanupRuntime(result);
  }
});

test("path traversal stays fatally blocked and never consumes the bounded recovery loop", { timeout: 45_000 }, async () => {
  const result = await runRuntimeCase("fatal_path_escape");
  try {
    assert.ok(result.events.some((event) => event.type === "stream.blocked"));
    assert.equal(
      result.events.some((event) => event.type === "recovery.scheduled"),
      false,
      `Fatal path escape must not schedule recovery. Events: ${JSON.stringify(result.events)}`,
    );
    assert.equal(existsSync(join(result.runtimeRoot, "escape.ts")), false);
    const repository = new SqliteTaskRepository(result.databasePath);
    const task = repository.findTask(result.taskId);
    const workflow = repository.findWorkflow("recovery-project");
    const classifications = repository.listEvents(result.taskId).filter((event) => event.type === "IMPLEMENTATION_FAILURE_CLASSIFIED");
    assert.equal(task?.state, "BLOCKED");
    assert.equal(workflow?.status, "blocked");
    assert.equal(workflow?.recovery.status, "blocked");
    assert.equal(workflow?.recovery.category, "path_escape");
    assert.equal(workflow?.recovery.previousTaskState, "IMPLEMENTING");
    assert.equal(workflow?.recovery.resumeAction, "inspect_worktree");
    assert.match(workflow?.recovery.reason ?? "", /operator inspection|requested path/i);
    assert.ok(classifications.some((event) => {
      const decision = event.payload.decision as { category?: string; disposition?: string };
      return decision.category === "path_escape" && decision.disposition === "fatal";
    }));
    assert.equal(task?.attempts, 0);
    repository.close();
  } finally {
    await cleanupRuntime(result);
  }
});

