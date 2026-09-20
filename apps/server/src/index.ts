import { createServer, type ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import {
  createApproval,
  createHandoff,
  createRoleAssignment,
  createReviewRun,
  createTask,
  createTaskCheckpoint,
  createTaskContinuation,
  type EngineeringDiscipline,
  type EngineeringRole,
  type Finding,
  type ReviewDecision,
  type RoleAssignment,
  type Task,
  type TaskCheckpoint,
  type TaskContinuation,
  type TaskState,
  type WorkflowState,
} from "../../../packages/core/src/contracts.ts";
import { WorkflowEngine } from "../../../packages/core/src/workflow-engine.ts";
import { normalizeWorkflowEvents } from "../../../packages/core/src/workflow-events.ts";
import { DebugSnapshotSchema, evaluateDebugInvariants, redactDebugValue, type DebugSnapshot } from "../../../packages/core/src/control-plane-debug.ts";
import { taskRepositoryPath } from "../../../packages/core/src/task-repository-binding.ts";
import { assertExecutionTransition, buildRepairContext, formatRepairContext, type ExecutionState } from "../../../packages/core/src/execution-state.ts";
import { evaluateContinuation } from "../../../packages/core/src/continuation-policy.ts";
import { applyReviewDecision, blockingReviewFindings, reconcileReviewRun, stateForDecision } from "../../../packages/core/src/review-history.ts";
import { SqliteTaskRepository } from "../../../packages/persistence/src/sqlite-task-repository.ts";
import { AccessController } from "../../../packages/repository/src/access-controller.ts";
import { RepositoryMemory, type MemoryNote } from "../../../packages/repository/src/repository-memory.ts";
import { GitWorktreeManager } from "../../../packages/repository/src/git-worktree-manager.ts";
import { WorktreeDelivery } from "../../../packages/repository/src/worktree-delivery.ts";
import { inspectProjectTree, resolveProjectPath } from "../../../packages/repository/src/project-inspection.ts";
import { ToolBroker, type PermissionMode } from "../../../packages/tools/src/tool-broker.ts";
import { DesktopCredentialStore } from "../../../packages/tools/src/credential-store.ts";
import { ProjectEnvironmentStore } from "../../../packages/tools/src/project-environment.ts";
import type { BrowserEvidenceReport } from "../../../packages/browser-verification/src/index.ts";
import { OllamaVisionProvider, VisionReviewService, type VisionReviewResult } from "../../../packages/vision-review/src/index.ts";
import { VisualRegressionService, type BaselineCandidate, type VisualRegressionReport } from "../../../packages/visual-regression/src/index.ts";
import {
  DisciplineRouter,
  TeamPolicyService,
  evaluateSpecialistEvidence,
  roleCapabilities,
  selectSpecialistPacks,
  specialistPackRefs,
  specialistSystemInstructions,
  verificationProfileFor,
  type SpecialistCapabilityPack,
} from "../../../packages/orchestration/src/index.ts";
import { runFreshReview } from "./fresh-review.ts";
import { deriveWorkflowStatus } from "./workflow-status.ts";
import { runOllamaAgent } from "./ollama-agent.ts";
import { PlanningOrchestrator } from "./planning-orchestrator.ts";
import { resolveExecutionScopeMarkers, resolveExecutionTaskScope } from "./task-scope-resolver.ts";
import { classifyImplementationFailure, compactRecoveryEvidence, type RecoveryDecision } from "./recovery-policy.ts";
import { buildChangeLog } from "./change-log.ts";
import { ProcessRuntime, findAvailableLoopbackPort, type ProcessRuntimeEvent } from "../../../packages/process-runtime/src/index.ts";
import { websiteInfo } from "../../../packages/web-builder/src/project-bootstrap.ts";
import { preflightFailureMessage, runWorkspacePreflight } from "../../../packages/web-builder/src/workspace-preflight.ts";
import { projectWorkflowState } from "../../../packages/web-builder/src/workflow-projection.ts";
import { ensurePreviewDependencies } from "../../../packages/web-builder/src/preview-dependencies.ts";
import { websiteGenerationContext } from "../../../packages/web-builder/src/generation-context.ts";
import { compileFocusedFrontendContext, compileFrontendContext, compileStyleFrontendContext, type CompiledContext, type ContextItem } from "../../../packages/web-builder/src/context-compiler.ts";
import { updateVerifiedProjectModel } from "../../../packages/web-builder/src/project-model.ts";
import { approveProjectPlan, currentSlice, markSliceReady, parseProjectPlanResult, persistProposedProjectPlan, prepareSlice, projectDeliveredFrontendCheckpoint, projectPlanDelta, projectPlanRepairPrompt, projectPlanRevisionPrompt, readPersistedDesignBrief, readProjectDocs, readProjectPlan, readSliceState, setFrontendWorkflowStage, slicePrompt, validateProjectPlanCoverage, type ProjectPlan, type SliceAction, type SliceState } from "../../../packages/web-builder/src/slice-docs.ts";
import {
  DesignBriefSchema,
  DesignDirectorService,
  VisualDirectorService,
  designBriefPrompt,
  type DesignBrief,
  type DesignReviewResult,
} from "../../../packages/design-intelligence/src/index.ts";

const databasePath = resolve(process.env.BORG_DATABASE_PATH ?? ".borg/borg.db");
mkdirSync(dirname(databasePath), { recursive: true });
const tasks = new SqliteTaskRepository(databasePath);
const workflow = new WorkflowEngine(tasks);
const access = new AccessController(resolve(".borg/access.json"));
const memory = new RepositoryMemory(resolve(".borg/repository-memory.db"));
const projectEnvironment = new ProjectEnvironmentStore(resolve(".borg/project-environment.json"), new DesktopCredentialStore());
const worktreeRoot = resolve(".borg/worktrees");
const processRuntime = new ProcessRuntime({
  onEvent: (event: ProcessRuntimeEvent) => {
    if (event.type === "process.output") {
      appendTaskEvent(event.taskId, "PROCESS_OUTPUT", {
        processId: event.processId,
        stream: event.stream,
        text: event.text,
        occurredAt: event.occurredAt,
      });
      return;
    }
    appendTaskEvent(event.taskId, event.type === "process.started" ? "PROCESS_STARTED" : "PROCESS_STATE", {
      process: event.process,
      occurredAt: event.occurredAt,
    });
  },
});
const tools = new ToolBroker(resolve(".borg/tools.json"), access, {
  worktreeRoot,
  findApproval: (taskId) => tasks.findApproval(taskId),
  processRuntime,
  environmentForTask: (taskId) => {
    const repositoryPath = taskProjectRepository(taskId);
    return repositoryPath ? projectEnvironment.values(repositoryPath) : {};
  },
}, memory);
const worktrees = new GitWorktreeManager(worktreeRoot);
const delivery = new WorktreeDelivery(worktreeRoot, resolve(".borg/deliveries"));
const port = Number(process.env.BORG_PORT ?? 4311);
const ollamaUrl = process.env.BORG_OLLAMA_URL ?? "http://127.0.0.1:11434";
const model = process.env.BORG_MODEL ?? "qwen3-coder:30b";
const vision = new VisionReviewService(resolve(".borg/vision.json"), new OllamaVisionProvider(ollamaUrl));
const designDirector = new DesignDirectorService(ollamaUrl);
const visualDirector = new VisualDirectorService(ollamaUrl);
const visualRegression = new VisualRegressionService();
const disciplineRouter = new DisciplineRouter();
const teamPolicies = new TeamPolicyService();
const maxRepairAttempts = 2;
const maxDesignRefinements = 3;

const planningOrchestrator = new PlanningOrchestrator({
  tasks,
  workflow,
  access,
  memory,
  tools,
  disciplineRouter,
  teamPolicies,
  designDirector,
  ollamaUrl,
  model,
  runAgent: runOllamaAgent,
  appendTaskEvent,
  syncWorkflowProjection,
  transitionTask,
  projectPlanFromWorkflow,
  sliceStateFromWorkflow,
  commitProjectRegistries,
  contextSourceHints,
  recordContextPack,
  recordModelInput,
  beginRole,
  finishRole,
  recordHandoff,
  createCheckpointSnapshot,
});

function changedSourcePaths(status: string) {
  return status.split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .map((value) => value.includes(" -> ") ? value.split(" -> ").at(-1)!.trim() : value)
    .filter((value) => value && !value.startsWith(".localcode/build/"));
}

function safeWorktreeFile(root: string, path: string) {
  const candidate = resolve(root, path);
  const rel = relative(resolve(root), candidate);
  if (rel === ".." || rel.startsWith(".." + sep)) return null;
  try {
    if (!existsSync(candidate) || !statSync(candidate).isFile() || statSync(candidate).size > 256_000) return null;
    return readFileSync(candidate, "utf8");
  } catch {
    return null;
  }
}

function sourceMutationSnapshot(root: string) {
  const status = gitRead(root, ["status", "--porcelain", "--untracked-files=all"]) ?? "";
  const diff = gitRead(root, ["diff", "--no-ext-diff", "--binary", "--", ".", ":(exclude).localcode/build/**"]) ?? "";
  const paths = changedSourcePaths(status);
  const sourceStatus = status.split(/\r?\n/).filter((line) => line && !line.includes(".localcode/build/"));
  const fileHashes = paths.map((path) => {
    const content = safeWorktreeFile(root, path);
    return [path, content === null ? null : createHash("sha256").update(content).digest("hex")];
  });
  const fingerprint = createHash("sha256").update(JSON.stringify({ status: sourceStatus, diff, fileHashes })).digest("hex");
  return { status, diff, paths, fingerprint };
}

function directRepairDependencies(root: string, paths: string[]) {
  const dependencies = new Set<string>();
  const extensions = ["", ".ts", ".tsx", ".js", ".jsx", ".css", ".scss", ".json"];
  for (const path of paths.slice(0, 20)) {
    const content = safeWorktreeFile(root, path);
    if (!content) continue;
    const imports = [
      ...content.matchAll(/(?:from\s*|import\s*\(|require\s*\(|@import\s*)["'](\.[^"']+)["']/g),
    ].map((match) => match[1]);
    for (const specifier of imports.slice(0, 40)) {
      const absoluteBase = resolve(dirname(resolve(root, path)), specifier);
      const candidates = [
        ...extensions.map((extension) => absoluteBase + extension),
        ...extensions.filter(Boolean).map((extension) => resolve(absoluteBase, "index" + extension)),
      ];
      const match = candidates.find((candidate) => {
        const rel = relative(resolve(root), candidate);
        return rel !== ".."
          && !rel.startsWith(".." + sep)
          && existsSync(candidate)
          && statSync(candidate).isFile()
          && statSync(candidate).size <= 256_000;
      });
      if (!match) continue;
      const rel = relative(resolve(root), match).replaceAll("\\", "/");
      if (!rel.startsWith(".localcode/") && !rel.includes("/node_modules/")) dependencies.add(rel);
    }
  }
  return [...dependencies].filter((path) => !paths.includes(path)).slice(0, 20);
}

function repairGroundingSnapshot(root: string) {
  const snapshot = sourceMutationSnapshot(root);
  const dependencyPaths = directRepairDependencies(root, snapshot.paths);
  const changedFiles = snapshot.paths.slice(0, 12).map((path) => {
    const content = safeWorktreeFile(root, path);
    return content === null ? `### ${path}\n[unavailable or non-text]` : `### ${path}\n${content.slice(0, 12_000)}`;
  });
  const dependencies = dependencyPaths.slice(0, 12).map((path) => {
    const content = safeWorktreeFile(root, path);
    return content === null ? `### ${path}\n[unavailable or non-text]` : `### ${path}\n${content.slice(0, 8_000)}`;
  });
  return [
    "CURRENT WORKTREE GROUNDING. This snapshot is authoritative for the repair pass; do not rediscover or guess paths.",
    `Changed source files:\n${snapshot.paths.length ? snapshot.paths.map((path) => `- ${path}`).join("\n") : "- none"}`,
    dependencyPaths.length ? `Direct relative dependencies automatically resolved from changed files:\n${dependencyPaths.map((path) => `- ${path}`).join("\n")}` : "",
    `Current source diff:\n${snapshot.diff.slice(0, 40_000) || "[no tracked diff]"}`,
    changedFiles.length ? `Current changed-file contents:\n${changedFiles.join("\n\n")}` : "",
    dependencies.length ? `Current direct-dependency contents:\n${dependencies.join("\n\n")}` : "",
    "Use this bounded neighborhood first. Read beyond it only when a direct dependency proves another file is required for the evidenced repair.",
  ].filter(Boolean).join("\n\n");
}

async function visionRuntimeStatus() {
  const policy = vision.status();
  try {
    const response = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`Ollama model discovery returned ${response.status}.`);
    const body = await response.json() as { models?: { name?: string; model?: string }[] };
    const modelAvailable = (body.models ?? []).some((item) => item.name === policy.model || item.model === policy.model);
    return {
      ...policy,
      modelAvailable,
      availabilityState: modelAvailable ? "available" as const : "missing" as const,
      availabilityError: modelAvailable ? null : `Vision model ${policy.model} is not installed in Ollama.`,
    };
  } catch (error) {
    return {
      ...policy,
      modelAvailable: false,
      availabilityState: "connection_failed" as const,
      availabilityError: error instanceof Error ? error.message : String(error),
    };
  }
}

function recordModelInput(taskId: string, role: string, selectedModel: string, sliceId: string | null, manifest: ContextItem[], body: string) {
  const id = randomUUID();
  tasks.saveModelContext({ id, taskId, role, model: selectedModel, sliceId, inputText: body, manifest, inputSha256: createHash("sha256").update(body).digest("hex"), createdAt: new Date().toISOString() });
  appendTaskEvent(taskId, "MODEL_CONTEXT_RECORDED", { id, role, model: selectedModel, sliceId, included: manifest.length, characters: body.length });
}

function contextSourceHints(root: string, query: string): string[] {
  try {
    return memory.relatedPaths(root, query, 12, (path) => access.allowsRepositoryFile(path));
  } catch {
    return [];
  }
}

function recordContextPack(taskId: string, projectId: string, pack: CompiledContext) {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  tasks.saveContextPack({ id, taskId, projectId, pack, createdAt });
  appendTaskEvent(taskId, "CONTEXT_PACK_COMPILED", {
    id,
    profile: pack.profile,
    authority: pack.authority,
    fingerprint: pack.fingerprint,
    included: pack.manifest.length,
    characters: pack.characters,
    budgetCharacters: pack.budgetCharacters,
  });
  return id;
}

function commitBuildDocs(repositoryPath: string, message: string) {
  execFileSync("git", ["-C", repositoryPath, "add", "--", ".localcode/build"], { stdio: "ignore" });
  const staged = execFileSync("git", ["-C", repositoryPath, "diff", "--cached", "--name-only", "--", ".localcode/build"], { encoding: "utf8" }).trim();
  if (!staged) return;
  execFileSync("git", ["-C", repositoryPath, "-c", "user.name=BORG", "-c", "user.email=borg@local.invalid", "commit", "-m", message, "--", ".localcode/build"], { stdio: "ignore" });
}

function boundedDebugLog(value: string, maximum = 20_000) {
  return value.length > maximum ? value.slice(value.length - maximum) : value;
}

function gitRead(root: string | null, args: string[]): string | null {
  if (!root || !existsSync(root)) return null;
  try { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true }).trim(); }
  catch { return null; }
}

function gitIsAncestor(root: string | null, ancestor: string | null, descendant = "HEAD"): boolean | null {
  if (!root || !ancestor || !existsSync(root)) return null;
  try {
    execFileSync("git", ["-C", root, "merge-base", "--is-ancestor", ancestor, descendant], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function buildDebugSnapshot(taskId: string): DebugSnapshot | null {
  const task = tasks.findTask(taskId);
  if (!task) return null;
  const approval = tasks.findApproval(taskId);
  const events = tasks.listEvents(taskId);
  const projectWorkflow = workflow.get(task.projectId);
  const ownedWorkflow = projectWorkflow?.taskId === task.id ? projectWorkflow : null;
  const repositoryPath = taskProjectRepository(taskId);
  const worktreePath = approval?.worktreePath ?? null;
  const root = worktreePath && existsSync(worktreePath) ? worktreePath : repositoryPath && existsSync(repositoryPath) ? repositoryPath : null;
  const plan = projectPlanFromWorkflow(ownedWorkflow, root);
  const slice = sliceStateFromWorkflow(ownedWorkflow, plan, root);
  const baselineCandidates = pendingVisualBaselineCandidates(taskId);
  const status = deriveWorkflowStatus(task, events, plan, slice, ownedWorkflow, { baselineApprovalCount: baselineCandidates.length });

  const contextPacks = tasks.listContextPacks(taskId).slice(0, 20).map((record) => ({
    id: record.id,
    profileId: record.pack.profile.id,
    kind: record.pack.profile.kind,
    stage: record.pack.profile.stage,
    workflowVersion: record.pack.profile.workflowVersion,
    sliceId: record.pack.sliceId,
    authority: record.pack.authority,
    fingerprint: record.pack.fingerprint,
    characters: record.pack.characters,
    budgetCharacters: record.pack.budgetCharacters,
    manifestCount: record.pack.manifest.length,
    manifest: record.pack.manifest.map((item) => ({
      kind: item.kind,
      path: item.path,
      reason: item.reason,
      characters: item.characters,
      required: item.required,
    })),
    createdAt: record.createdAt,
  }));
  const modelContexts = tasks.listModelContexts(taskId).slice(0, 20).map((record) => ({
    id: record.id,
    role: record.role,
    model: record.model,
    sliceId: record.sliceId,
    inputSha256: record.inputSha256,
    manifestCount: record.manifest.length,
    createdAt: record.createdAt,
  }));
  const processes = processRuntime.list(taskId).slice(-30).map((process) => ({
    id: process.id,
    kind: process.kind,
    label: process.label,
    command: process.command,
    args: process.args,
    cwd: process.cwd,
    url: process.url,
    pid: process.pid,
    status: process.status,
    exitCode: process.exitCode,
    timedOut: process.timedOut,
    startedAt: process.startedAt,
    completedAt: process.completedAt,
    durationMs: process.durationMs,
    stdout: boundedDebugLog(process.stdout),
    stderr: boundedDebugLog(process.stderr),
  }));
  const roleAssignments = tasks.listRoleAssignments(taskId);
  const diagnostics = evaluateDebugInvariants({
    task,
    workflow: ownedWorkflow,
    approval,
    latestContextWorkflowVersion: contextPacks[0]?.workflowVersion ?? null,
    latestContextKind: contextPacks[0]?.kind ?? null,
    latestContextManifestCount: contextPacks[0]?.manifestCount ?? null,
    latestContextCharacters: contextPacks[0]?.characters ?? null,
    latestContextBudgetCharacters: contextPacks[0]?.budgetCharacters ?? null,
    worktreeExists: worktreePath ? existsSync(worktreePath) : null,
    baseCommitAncestorOfHead: gitIsAncestor(root, approval?.baseCommit ?? null),
    activeRoleCount: roleAssignments.filter((assignment) => assignment.status === "active").length,
    activeProcessCount: processes.filter((process) => process.status === "starting" || process.status === "running").length,
    failedProcessCount: processes.filter((process) => process.status === "failed").length,
    latestEventAt: events.at(-1)?.occurredAt ?? null,
  });

  const snapshot = {
    version: 1 as const,
    generatedAt: new Date().toISOString(),
    readOnly: true as const,
    task,
    workflow: ownedWorkflow,
    approval,
    status: { ...status, baselineApprovalCount: baselineCandidates.length },
    events: normalizeWorkflowEvents(task, events).slice(-150),
    contextPacks,
    modelContexts,
    processes,
    git: {
      repositoryPath,
      worktreePath,
      baseCommit: approval?.baseCommit ?? null,
      headCommit: gitRead(root, ["rev-parse", "HEAD"]),
      status: gitRead(root, ["status", "--short"]) ?? "",
      worktreeExists: worktreePath ? existsSync(worktreePath) : null,
    },
    checkpoints: tasks.listCheckpoints(taskId).slice(-20),
    continuations: tasks.listContinuations(taskId).slice(-20),
    roleAssignments: roleAssignments.slice(-30),
    handoffs: tasks.listHandoffs(taskId).slice(-30),
    reviewRuns: tasks.listReviewRuns(taskId).slice(-20),
    reviewFindings: tasks.listReviewFindings(taskId).slice(-50),
    diagnostics,
    redaction: {
      version: 1 as const,
      sensitiveFieldsRedacted: true,
      rawModelInputIncluded: false as const,
      environmentValuesIncluded: false as const,
    },
  };
  return DebugSnapshotSchema.parse(redactDebugValue(snapshot));
}

function pendingVisualBaselineCandidates(taskId: string): BaselineCandidate[] {
  const events = tasks.listEvents(taskId);
  const latest = events.findLast((event) => event.type === "VISUAL_REGRESSION_COMPLETED");
  const report = latest?.payload.report as VisualRegressionReport | undefined;
  if (!report?.requiresAcceptance) return [];
  const accepted = new Set<string>();
  for (const event of events.filter((candidate) => candidate.type === "VISUAL_BASELINES_ACCEPTED")) {
    const values = Array.isArray(event.payload.accepted) ? event.payload.accepted as Array<{ profileId?: string; screenshotName?: string }> : [];
    for (const value of values) accepted.add(`${value.profileId ?? ""}::${value.screenshotName ?? ""}`);
  }
  return report.comparisons
    .filter((comparison) => comparison.status === "missing-baseline")
    .filter((comparison) => !accepted.has(`${comparison.profileId}::${comparison.screenshotName}`))
    .map((comparison) => ({
      profileId: comparison.profileId,
      screenshotName: comparison.screenshotName,
      candidatePath: comparison.candidate.path,
      candidateSha256: comparison.candidate.sha256,
      width: comparison.candidate.width,
      height: comparison.candidate.height,
    }));
}

function commitProjectRegistries(repositoryPath: string) {
  const paths = [".localcode/build/pages.json", ".localcode/build/components.json"];
  execFileSync("git", ["-C", repositoryPath, "add", "--", ...paths], { stdio: "ignore" });
  execFileSync("git", ["-C", repositoryPath, "-c", "user.name=BORG", "-c", "user.email=borg@local.invalid", "commit", "-m", "Initialize BORG project registries", "--", ...paths], { stdio: "ignore" });
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "http://localhost:5173",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  response.end(JSON.stringify(body));
}

function readJson(request: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, reject) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      try { resolveBody(JSON.parse(body) as Record<string, unknown>); }
      catch (error) { reject(error); }
    });
    request.on("error", reject);
  });
}

function writeEvent(response: ServerResponse, event: Record<string, unknown>) {
  response.write(`${JSON.stringify(event)}\n`);
}

function appendTaskEvent(taskId: string, type: string, payload: Record<string, unknown>) {
  tasks.appendEvent({ id: randomUUID(), taskId, type, payload, occurredAt: new Date().toISOString() });
}

function latestDesignBrief(taskId: string): DesignBrief | null {
  const value = tasks.listEvents(taskId).findLast((event) => event.type === "DESIGN_BRIEF_CREATED")?.payload.brief;
  const parsed = DesignBriefSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function designRefinementCount(taskId: string): number {
  const events = tasks.listEvents(taskId);
  const latestRevision = events.findLastIndex((event) => event.type === "PROJECT_PLAN_REVISION_APPROVED");
  return events.slice(latestRevision + 1).filter((event) => event.type === "DESIGN_REFINEMENT_SCHEDULED").length;
}

function recordMemoryNote(root: string, note: MemoryNote) {
  try { memory.recordNote(root, note); }
  catch (error) { appendTaskEvent(note.taskId, "REPOSITORY_MEMORY_FAILED", { message: error instanceof Error ? error.message : String(error) }); }
}

function recordCompletedReview(
  task: Task,
  findings: Finding[],
  verdict: "pass" | "repair" | "unknown",
  summary: string,
  resolutionEvidence: string[] = [],
) {
  const safeFindings = findings.map((finding) => finding.file && !access.allowsRepositoryFile(finding.file)
    ? { ...finding, file: undefined, line: undefined }
    : finding);
  const checkpoint = tasks.listCheckpoints(task.id).at(-1) ?? null;
  const continuation = tasks.listContinuations(task.id).at(-1) ?? null;
  const run = createReviewRun({
    id: randomUUID(), taskId: task.id, checkpointId: checkpoint?.id ?? null,
    continuationId: continuation?.id ?? null, attempt: task.attempts,
    status: "completed", verdict, summary, completed: true,
  });
  const reconciled = reconcileReviewRun({
    run,
    incoming: safeFindings,
    existing: tasks.listReviewFindings(task.id),
    resolutionEvidence,
  });
  tasks.saveReviewHistory({ run, ...reconciled });
  // Compatibility projection for pre-history clients. The durable source of
  // truth is review_finding_records plus append-only review_decisions.
  tasks.replaceFindings(task.id, reconciled.records
    .filter((record) => record.state === "open" || record.state === "accepted" || record.state === "reopened")
    .map((record) => record.finding));
  appendTaskEvent(task.id, "REVIEW_HISTORY_RECONCILED", {
    runId: run.id,
    findingIds: reconciled.records.map((record) => record.id),
    automaticDecisionIds: reconciled.decisions.map((decision) => decision.id),
  });
  return { run, ...reconciled };
}

const checkpointStateOrder: TaskState[] = [
  "CREATED", "CLASSIFYING", "DISCOVERING", "PLANNING", "AWAITING_APPROVAL",
  "IMPLEMENTING", "VERIFYING", "REVIEWING", "DELIVERY_READY", "DELIVERING", "COMPLETE",
];

function checkpointLabel(kind: TaskCheckpoint["kind"]): string {
  return {
    manual: "Manual checkpoint",
    plan_complete: "Plan complete",
    pre_edit: "Before approved edit",
    implementation_complete: "Implementation complete",
    verification_complete: "Verification complete",
    pre_repair: "Before repair",
    pre_delivery: "Ready for delivery",
    interrupted: "Interrupted task recovery",
  }[kind];
}

function recordedMode(taskId: string): PermissionMode {
  const event = tasks.listEvents(taskId).findLast((value) => value.type === "APPROVAL_REQUESTED");
  const value = String(event?.payload.mode ?? "");
  if (value === "ask" || value === "plan" || value === "edit" || value === "agent") return value;
  return tasks.findApproval(taskId)?.status === "APPROVED" ? "edit" : "plan";
}

function createCheckpointSnapshot(
  task: Task,
  kind: TaskCheckpoint["kind"],
  input: Partial<Pick<TaskCheckpoint, "name" | "sessionId" | "mode" | "contextSummary">> = {},
): TaskCheckpoint {
  const events = tasks.listEvents(task.id);
  const approval = tasks.findApproval(task.id);
  const assignments = tasks.listRoleAssignments(task.id);
  const activeAssignment = assignments.findLast((value) => value.status === "active") ?? assignments.at(-1) ?? null;
  const plan = events.findLast((value) =>
    value.type === "PLAN_REVISION_MODEL_RESPONSE_COMPLETED" || value.type === "MODEL_RESPONSE_COMPLETED"
  )?.payload.answer;
  const stateIndex = checkpointStateOrder.indexOf(task.state);
  const steps = checkpointStateOrder.filter((value) => !["PAUSED", "RECOVERY_REQUIRED"].includes(value));
  const durableWorkflow = workflow.get(task.projectId);
  const checkpoint = createTaskCheckpoint({
    id: randomUUID(),
    taskId: task.id,
    sessionId: input.sessionId ?? null,
    name: input.name?.trim().slice(0, 200) || checkpointLabel(kind),
    kind,
    taskState: task.state,
    mode: input.mode ?? recordedMode(task.id),
    repositoryPath: taskProjectRepository(task.id),
    worktreePath: approval?.worktreePath ?? null,
    baseCommit: approval?.baseCommit ?? null,
    headCommit: approval?.baseCommit ?? null,
    approvalId: approval?.id ?? null,
    approvalStatus: approval?.status ?? null,
    planText: typeof plan === "string" ? plan : "",
    contextSummary: (input.contextSummary?.trim() || events.slice(-12).map((value) => value.type).join(" → ")).slice(0, 20_000),
    completedSteps: stateIndex < 0 ? [] : steps.slice(0, stateIndex + 1),
    remainingSteps: stateIndex < 0 ? steps : steps.slice(stateIndex + 1),
    lastEventId: events.at(-1)?.id ?? null,
    activeRole: activeAssignment?.role ?? null,
    specialistPacks: activeAssignment?.specialistPacks ?? [],
    workflowVersion: durableWorkflow?.version ?? null,
    verification: durableWorkflow?.verification,
    recovery: durableWorkflow?.recovery,
  });
  tasks.saveCheckpoint(checkpoint);
  appendTaskEvent(task.id, "TASK_CHECKPOINT_CREATED", {
    checkpointId: checkpoint.id,
    name: checkpoint.name,
    kind: checkpoint.kind,
    state: checkpoint.taskState,
    workflowVersion: checkpoint.workflowVersion,
    verificationStatus: checkpoint.verification.status,
    recoveryStatus: checkpoint.recovery.status,
  });
  return checkpoint;
}

async function continueFromCheckpoint(task: Task, checkpoint: TaskCheckpoint, reason: string): Promise<TaskContinuation> {
  if (checkpoint.taskId !== task.id) throw new Error("Checkpoint does not belong to this task.");
  const previousState = task.state;
  const approval = tasks.findApproval(task.id);
  let repositoryState: TaskContinuation["repositoryState"] = "not_applicable";
  let repositoryDetail = "";

  if (checkpoint.worktreePath) {
    const inspected = await worktrees.inspect(checkpoint.worktreePath, checkpoint.baseCommit);
    repositoryState = inspected.state;
    repositoryDetail = inspected.detail;
  }
  const { status, resultingState, resumeAction, detail } = evaluateContinuation(checkpoint, approval?.status ?? null, repositoryState, repositoryDetail);
  const unresolvedReviewFindings = blockingReviewFindings(tasks.listReviewFindings(task.id));

  const parent = tasks.listContinuations(task.id).at(-1) ?? null;
  const restoredMode: PermissionMode = status === "recovery_required" ? "plan" : checkpoint.mode;
  const continuation = createTaskContinuation({
    id: randomUUID(),
    taskId: task.id,
    checkpointId: checkpoint.id,
    parentContinuationId: parent?.id ?? null,
    reason: reason.trim().slice(0, 1000) || "Resume from named checkpoint.",
    status,
    restoredMode,
    previousState,
    resultingState,
    repositoryState,
    resumeAction,
    detail: unresolvedReviewFindings.length ? `${detail} ${unresolvedReviewFindings.length} unresolved high/critical review finding(s) remain attached to this continuation.` : detail,
    completed: true,
  });
  const restored = workflow.continueFromCheckpoint(task, continuation, {
    checkpoint,
    unresolvedReviewFindingIds: unresolvedReviewFindings.map((value) => value.id),
  });
  syncWorkflowProjection(restored.task, restored.workflow);
  return continuation;
}

async function reconcileInterruptedDelivery(task: Task): Promise<boolean> {
  if (task.state !== "DELIVERING") return false;
  const approval = tasks.findApproval(task.id);
  const started = tasks.listEvents(task.id).findLast((event) => event.type === "DELIVERY_STARTED");
  const method = started?.payload.method;
  const recordedRoot = taskProjectRepository(task.id);
  const current = workflow.get(task.projectId);
  if (
    method !== "commit"
    || !approval?.worktreePath
    || !approval.baseCommit
    || !recordedRoot
    || current?.taskId !== task.id
    || current.loop !== "slice"
    || current.phase !== "frontend"
  ) return false;

  try {
    const reconciled = await delivery.reconcilePromotion(task.id, approval.worktreePath, {
      repositoryPath: recordedRoot,
      expectedBaseCommit: approval.baseCommit,
    });
    if (reconciled.state !== "promoted" || !reconciled.commit) return false;

    const completed = workflow.completeDelivery(task, {
      method: "commit",
      commit: reconciled.commit,
      worktreePath: approval.worktreePath,
      reconciledAfterRestart: true,
    });
    syncWorkflowProjection(completed.task, completed.workflow);
    syncDeliveredWorkflowProjection(completed.task, completed.workflow, recordedRoot);
    projectDeliveredFrontendCheckpoint(recordedRoot, completed.workflow);
    commitBuildDocs(recordedRoot, "Project BORG frontend workflow checkpoint");
    appendTaskEvent(task.id, "DELIVERY_RECONCILED_AFTER_RESTART", {
      commit: reconciled.commit,
      detail: reconciled.detail,
      workflowVersion: completed.workflow.version,
      pendingCommandId: completed.workflow.pendingCommand?.id ?? null,
    });
    return true;
  } catch (error) {
    appendTaskEvent(task.id, "DELIVERY_RECONCILIATION_FAILED", {
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function recoverInterruptedTasks(): Promise<void> {
  for (const task of tasks.listInterruptedTasks()) {
    if (workflow.get(task.projectId)?.taskId !== task.id) continue;
    try {
      if (await reconcileInterruptedDelivery(task)) continue;
      const checkpoint = createCheckpointSnapshot(task, "interrupted");
      const recovered = workflow.markRecoveryRequired(task, {
        category: "process_interrupted",
        checkpointId: checkpoint.id,
        resumeAction: "inspect_worktree",
        reason: "The server restarted while an active lifecycle stage was running.",
      });
      syncWorkflowProjection(recovered.task, recovered.workflow);
    } catch (error) {
      console.error(`[workflow] startup recovery failed for task ${task.id}`, error);
    }
  }
}

function workflowProjectionRoot(task: Task): string | null {
  const approval = tasks.findApproval(task.id);
  return approval?.status === "APPROVED" && approval.worktreePath ? approval.worktreePath : null;
}

function taskProjectRepository(taskId: string): string | null {
  const task = tasks.findTask(taskId);
  if (!task) return null;
  return taskRepositoryPath(tasks.listEvents(taskId));
}

function taskWorkflowAuthorityProjectId(taskId: string): string | null {
  const event = tasks.listEvents(taskId).findLast((candidate) => candidate.type === "PROJECT_WORKFLOW_AUTHORITY_BOUND");
  const projectId = event?.payload.projectId;
  return typeof projectId === "string" && projectId.trim() ? projectId : null;
}

function taskProjectRoot(taskId: string): string | null {
  const task = tasks.findTask(taskId);
  if (!task) return null;
  const approval = tasks.findApproval(taskId);
  if (approval?.worktreePath && existsSync(approval.worktreePath)) return approval.worktreePath;
  return taskProjectRepository(taskId);
}

function recordWorkflowProjectionFailure(taskId: string, state: WorkflowState, root: string, error: unknown) {
  appendTaskEvent(taskId, "WORKFLOW_PROJECTION_FAILED", {
    workflowVersion: state.version,
    root,
    message: error instanceof Error ? error.message : String(error),
  });
}

function syncWorkflowProjection(task: Task, state: WorkflowState): WorkflowState {
  const root = workflowProjectionRoot(task);
  if (!root) return state;
  try {
    projectWorkflowState(root, state, { untrackGeneratedFile: true });
  } catch (error) {
    recordWorkflowProjectionFailure(task.id, state, root, error);
  }
  return state;
}

function syncDeliveredWorkflowProjection(task: Task, state: WorkflowState, repositoryPath: string): WorkflowState {
  try {
    projectWorkflowState(repositoryPath, state);
  } catch (error) {
    recordWorkflowProjectionFailure(task.id, state, repositoryPath, error);
  }
  return state;
}

function projectPlanFromWorkflow(state: WorkflowState | null, fallbackRoot: string | null): ProjectPlan | null {
  // Once SQLite workflow state exists, it is the only progression authority.
  // Markdown is consulted only for pre-migration projects with no workflow row.
  if (state) return state.projectPlan as ProjectPlan | null;
  return fallbackRoot ? readProjectPlan(fallbackRoot) : null;
}

function sliceStateFromWorkflow(state: WorkflowState | null, plan: ProjectPlan | null, fallbackRoot: string | null): SliceState | null {
  if (state?.projectPlan && plan && state.sliceIndex !== null && (state.loop === "project" || state.loop === "slice")) {
    const status: SliceState["status"] = plan.status === "frontend_complete"
      ? "frontend_complete"
      : state.pendingCommand?.action === "start_slice" || state.nextAction === "start_slice"
        ? "ready"
        : state.pendingCommand?.action === "advance_slice" || state.status === "awaiting_feedback" || state.nextAction === "advance_slice" || state.nextAction === "request_feedback"
          ? "awaiting_feedback"
          : "working";
    return {
      version: 2,
      current: state.sliceIndex,
      total: plan.slices.length,
      currentTitle: state.sliceTitle ?? plan.slices[state.sliceIndex]?.title ?? "Frontend",
      status,
      brief: plan.siteGoal,
      lastTaskId: state.taskId,
      feedback: state.feedback,
      planRevision: plan.revision,
      backendRequired: plan.backendRequired,
    };
  }
  if (state) return null;
  return fallbackRoot ? readSliceState(fallbackRoot) : null;
}

function transitionTask(task: Task, state: TaskState, emit?: (event: Record<string, unknown>) => void): Task {
  const { task: updated, workflow: workflowState } = workflow.transition(task, state);
  syncWorkflowProjection(updated, workflowState);
  const automaticKind: Partial<Record<TaskState, TaskCheckpoint["kind"]>> = {
    AWAITING_APPROVAL: "plan_complete",
    VERIFYING: "implementation_complete",
    REVIEWING: "verification_complete",
    DELIVERY_READY: "pre_delivery",
  };
  const kind = automaticKind[state];
  if (kind) createCheckpointSnapshot(updated, kind);
  emit?.({ type: "task.state", taskId: task.id, state, workflow: workflowState });
  return updated;
}

function beginRole(
  task: Task,
  role: EngineeringRole,
  discipline: EngineeringDiscipline,
  selectedModel: string | null,
  packs: readonly SpecialistCapabilityPack[],
  emit?: (event: Record<string, unknown>) => void,
): RoleAssignment {
  const assignment = createRoleAssignment({
    id: randomUUID(),
    taskId: task.id,
    role,
    discipline,
    model: selectedModel,
    attempt: task.attempts,
    capabilities: roleCapabilities(role),
    specialistPacks: specialistPackRefs(packs),
  });
  tasks.saveRoleAssignment(assignment);
  appendTaskEvent(task.id, "ROLE_ASSIGNMENT_STARTED", { assignment });
  emit?.({ type: "role.started", assignment });
  return assignment;
}

function finishRole(
  assignment: RoleAssignment,
  status: "completed" | "failed",
  emit?: (event: Record<string, unknown>) => void,
): RoleAssignment {
  const completed = { ...assignment, status, completedAt: new Date().toISOString() };
  tasks.saveRoleAssignment(completed);
  appendTaskEvent(assignment.taskId, "ROLE_ASSIGNMENT_COMPLETED", { assignment: completed });
  emit?.({ type: "role.completed", assignment: completed });
  return completed;
}

function recordHandoff(input: {
  task: Task;
  fromRole: EngineeringRole;
  toRole: EngineeringRole;
  objective: string;
  constraints?: string[];
  repositoryContext?: string[];
  completedWork?: string[];
  changedFiles?: string[];
  evidence?: string[];
  openRisks?: string[];
  requiredNextAction: string;
}, emit?: (event: Record<string, unknown>) => void) {
  const handoff = createHandoff({
    id: randomUUID(),
    taskId: input.task.id,
    fromRole: input.fromRole,
    toRole: input.toRole,
    objective: input.objective,
    constraints: input.constraints ?? [],
    repositoryContext: input.repositoryContext ?? [],
    completedWork: input.completedWork ?? [],
    changedFiles: input.changedFiles ?? [],
    evidence: input.evidence ?? [],
    openRisks: input.openRisks ?? [],
    requiredNextAction: input.requiredNextAction,
  });
  tasks.saveHandoff(handoff);
  appendTaskEvent(input.task.id, "ROLE_HANDOFF_RECORDED", { handoff });
  const handoffWorkflow = workflow.setHandoff(input.task, JSON.stringify(handoff));
  syncWorkflowProjection(input.task, handoffWorkflow);
  emit?.({ type: "role.handoff", handoff });
  return handoff;
}

function scheduleDesignRefinement(task: Task, emit: (event: Record<string, unknown>) => void, reason: string): Task {
  createCheckpointSnapshot(task, "pre_repair");
  const updated = transitionTask(task, "IMPLEMENTING", emit);
  const refinement = designRefinementCount(task.id) + 1;
  appendTaskEvent(task.id, "DESIGN_REFINEMENT_SCHEDULED", { refinement, maximum: maxDesignRefinements, reason });
  emit({ type: "design.refinement.scheduled", refinement, maximum: maxDesignRefinements, message: reason });
  return updated;
}

function recoveryPayload(updated: Task, reason: string, recovery?: RecoveryDecision) {
  return { attempt: updated.attempts, maximum: maxRepairAttempts, reason, category: recovery?.category ?? null, action: recovery?.action ?? null };
}

function scheduleRepair(task: Task, emit: (event: Record<string, unknown>) => void, reason: string, recovery?: RecoveryDecision): Task {
  createCheckpointSnapshot(task, "pre_repair");
  const result = workflow.retry(task, {
    reason,
    eventType: "REPAIR_SCHEDULED",
    category: recovery?.category ?? null,
    action: recovery?.action ?? null,
  });
  syncWorkflowProjection(result.task, result.workflow);
  const payload = recoveryPayload(result.task, reason, recovery);
  emit({ type: recovery ? "recovery.scheduled" : "repair.scheduled", ...payload, message: reason });
  emit({ type: "task.state", taskId: task.id, state: result.task.state, workflow: result.workflow });
  return result.task;
}

function scheduleImplementationRetry(task: Task, emit: (event: Record<string, unknown>) => void, reason: string, recovery?: RecoveryDecision): Task {
  createCheckpointSnapshot(task, "pre_repair");
  const result = workflow.retry(task, {
    reason,
    eventType: "IMPLEMENTATION_RETRY_SCHEDULED",
    category: recovery?.category ?? null,
    action: recovery?.action ?? null,
  });
  syncWorkflowProjection(result.task, result.workflow);
  const payload = recoveryPayload(result.task, reason, recovery);
  emit({ type: recovery ? "recovery.scheduled" : "repair.scheduled", ...payload, message: reason });
  return result.task;
}

const server = createServer((request, response) => {
  if (request.method === "OPTIONS") return send(response, 204, null);
  if (request.method === "GET" && request.url === "/health") {
    void fetch(`${ollamaUrl}/api/tags`).then(async (runtimeResponse) => {
      const data = await runtimeResponse.json() as { models?: { name: string }[] };
      const models = data.models?.map((item) => item.name) ?? [];
      send(response, 200, { status: "ok", runtime: "ollama", runtimeConnected: runtimeResponse.ok, model, modelAvailable: models.includes(model) });
    }).catch(() => send(response, 200, { status: "ok", runtime: "ollama", runtimeConnected: false, model, modelAvailable: false }));
    return;
  }
  const projectRoute = request.url?.match(/^\/api\/tasks\/([^/?]+)\/project(?:\?(.+))?$/);
  if (request.method === "GET" && projectRoute) {
    const taskId = decodeURIComponent(projectRoute[1]);
    const root = taskProjectRoot(taskId);
    if (!root || !existsSync(root)) return send(response, 404, { error: "Project workspace not found." });
    const query = new URL(request.url!, `http://localhost:${port}`).searchParams;
    const requested = query.get("path");
    if (!requested) {
      try {
        const tree = inspectProjectTree(root);
        return send(response, 200, tree);
      } catch (error) {
        return send(response, 400, { error: error instanceof Error ? error.message : "Unable to inspect project files." });
      }
    }
    try {
      const target = resolveProjectPath(root, requested);
      if (!existsSync(target) || !statSync(target).isFile()) return send(response, 404, { error: "Project file not found." });
      if (statSync(target).size > 512_000) return send(response, 413, { error: "This file is too large to display." });
      return send(response, 200, { path: requested, content: readFileSync(target, "utf8") });
    } catch (error) {
      return send(response, 400, { error: error instanceof Error ? error.message : "Unable to read project file." });
    }
  }
  const environmentRoute = request.url?.match(/^\/api\/tasks\/([^/?]+)\/environment$/);
  if (environmentRoute) {
    const taskId = decodeURIComponent(environmentRoute[1]);
    const repositoryPath = taskProjectRepository(taskId);
    if (!repositoryPath || !existsSync(repositoryPath)) return send(response, 404, { error: "Project repository binding not found." });
    if (request.method === "GET") return send(response, 200, { variables: projectEnvironment.list(repositoryPath) });
    if (request.method === "POST") {
      void readJson(request).then((input) => {
        const name = typeof input.name === "string" ? input.name : "";
        const variables = input.remove === true
          ? projectEnvironment.delete(repositoryPath, name)
          : projectEnvironment.set(repositoryPath, name, typeof input.value === "string" ? input.value : "");
        return send(response, 200, { variables });
      }).catch((error) => send(response, 400, { error: error instanceof Error ? error.message : "Unable to update environment variables." }));
      return;
    }
  }

  const processStopRoute = request.url?.match(/^\/api\/tasks\/([^/]+)\/processes\/([^/]+)\/stop$/);
  if (request.method === "POST" && processStopRoute) {
    const taskId = decodeURIComponent(processStopRoute[1]);
    const processId = decodeURIComponent(processStopRoute[2]);
    if (!tasks.findTask(taskId)) return send(response, 404, { error: "Task not found." });
    const owned = processRuntime.list(taskId).find((value) => value.id === processId);
    if (!owned) return send(response, 404, { error: "Process not found for this task." });
    void processRuntime.stop(processId)
      .then((process) => send(response, 200, { process }))
      .catch((error) => send(response, 400, { error: error instanceof Error ? error.message : "Unable to stop process." }));
    return;
  }

  const processesRoute = request.url?.match(/^\/api\/tasks\/([^/]+)\/processes$/);
  if (request.method === "GET" && processesRoute) {
    const taskId = decodeURIComponent(processesRoute[1]);
    if (!tasks.findTask(taskId)) return send(response, 404, { error: "Task not found." });
    const events = tasks.listEvents(taskId)
      .filter((event) => event.type === "PROCESS_STARTED" || event.type === "PROCESS_OUTPUT" || event.type === "PROCESS_STATE")
      .map((event) => ({ type: event.type, payload: event.payload, occurredAt: event.occurredAt }));
    return send(response, 200, { taskId, processes: processRuntime.list(taskId), events });
  }

  const docsRoute = request.url?.match(/^\/api\/tasks\/([^/]+)\/docs$/);
  if (request.method === "GET" && docsRoute) {
    const taskId = decodeURIComponent(docsRoute[1]);
    const task = tasks.findTask(taskId);
    if (!task) return send(response, 404, { error: "Task not found" });
    const approvedPath = tasks.findApproval(taskId)?.worktreePath;
    const repositoryPath = taskProjectRepository(taskId);
    const root = approvedPath && websiteInfo(approvedPath) ? approvedPath : repositoryPath && websiteInfo(repositoryPath) ? repositoryPath : null;
    if (!root) return send(response, 200, { docs: [], slice: null });
    const events = tasks.listEvents(taskId);
    const independentWorkspace = events.some((event) => event.type === "STYLE_WORKSPACE_SELECTED" || event.type === "FOCUSED_WORKSPACE_SELECTED");
    const ownedWorkflow = workflow.get(task.projectId)?.taskId === task.id ? workflow.get(task.projectId) : null;
    const authorityProjectId = taskWorkflowAuthorityProjectId(task.id) ?? task.projectId;
    const authorityWorkflow = workflow.get(authorityProjectId);
    const plan = projectPlanFromWorkflow(authorityWorkflow ?? ownedWorkflow, root);
    const slice = independentWorkspace ? null : sliceStateFromWorkflow(ownedWorkflow, plan, root);
    return send(response, 200, { docs: readProjectDocs(root), slice });
  }
  const taskPreviewRoute = request.url?.match(/^\/api\/tasks\/([^/]+)\/preview$/);
  if (request.method === "POST" && taskPreviewRoute) {
    const taskId = decodeURIComponent(taskPreviewRoute[1]);
    const task = tasks.findTask(taskId);
    const approval = tasks.findApproval(taskId);
    if (!task || !approval?.worktreePath || approval.status !== "APPROVED") return send(response, 404, { error: "Approved task worktree not found." });
    const website = websiteInfo(approval.worktreePath);
    if (!website) return send(response, 404, { error: "This task worktree is not a BORG website project." });
    void (async () => {
      const running = processRuntime.findRunning(taskId, "dev_server");
      if (running?.url && running.status === "running") return send(response, 200, { preview: { url: running.url, status: "running", processId: running.id, pid: running.pid }, process: running });
      await ensurePreviewDependencies(taskId, website.path, processRuntime);
      const port = await findAvailableLoopbackPort();
      const url = `http://127.0.0.1:${port}`;
      const process = await processRuntime.ensureServer({
        taskId,
        kind: "dev_server",
        label: "Live preview",
        command: "npm",
        args: ["run", "dev", "--", "--port", String(port), "--strictPort"],
        cwd: website.path,
        url,
        env: { HOST: "127.0.0.1", BROWSER: "none" },
        startupTimeoutMs: 60_000,
      });
      const previewUrl = process.url ?? url;
      return send(response, 200, { preview: { url: previewUrl, status: "running", processId: process.id, pid: process.pid }, process });
    })().catch((error) => send(response, 502, { error: error instanceof Error ? error.message : "Unable to start task preview." }));
    return;
  }

  const designRoute = request.url?.match(/^\/api\/tasks\/([^/]+)\/design$/);
  if (request.method === "GET" && designRoute) {
    const taskId = decodeURIComponent(designRoute[1]);
    if (!tasks.findTask(taskId)) return send(response, 404, { error: "Task not found." });
    const events = tasks.listEvents(taskId);
    const approval = tasks.findApproval(taskId);
    const repositoryPath = taskProjectRepository(taskId);
    const designRoot = approval?.worktreePath && websiteInfo(approval.worktreePath)
      ? approval.worktreePath
      : repositoryPath && websiteInfo(repositoryPath)
        ? repositoryPath
        : null;
    const persistedBrief = designRoot ? readPersistedDesignBrief(designRoot) : null;
    const parsedPersistedBrief = persistedBrief ? DesignBriefSchema.safeParse(persistedBrief) : null;
    const brief = latestDesignBrief(taskId) ?? (parsedPersistedBrief?.success ? parsedPersistedBrief.data : null);
    const reviewEvent = events.findLast((event) => event.type === "DESIGN_REVIEW_COMPLETED" || event.type === "DESIGN_REVIEW_BLOCKED");
    const review = (reviewEvent?.payload.review ?? null) as DesignReviewResult | null;
    return send(response, 200, {
      taskId,
      brief,
      review,
      refinementCount: events.filter((event) => event.type === "DESIGN_REFINEMENT_SCHEDULED").length,
      maxRefinements: maxDesignRefinements,
      required: Boolean(brief),
    });
  }

  const activityRoute = request.url?.match(/^\/api\/tasks\/([^/]+)\/activity$/);
  if (request.method === "GET" && activityRoute) {
    const taskId = decodeURIComponent(activityRoute[1]);
    const task = tasks.findTask(taskId);
    if (!task) return send(response, 404, { error: "Task not found." });
    const activities = tasks.listEvents(taskId)
      .filter((event) => event.type === "AGENT_ACTIVITY")
      .map((event) => ({ ...(event.payload.activity as Record<string, unknown>), taskId }));
    return send(response, 200, { taskId, activities });
  }

  const contextRoute = request.url?.match(/^\/api\/tasks\/([^/]+)\/contexts(?:\/([^/?]+))?$/);
  if (request.method === "GET" && contextRoute) {
    const taskId = decodeURIComponent(contextRoute[1]);
    if (!tasks.findTask(taskId)) return send(response, 404, { error: "Task not found." });
    if (contextRoute[2]) {
      const context = tasks.findModelContext(taskId, decodeURIComponent(contextRoute[2]));
      return context ? send(response, 200, { context }) : send(response, 404, { error: "Model context not found." });
    }
    return send(response, 200, { contexts: tasks.listModelContexts(taskId) });
  }

  const contextPackRoute = request.url?.match(/^\/api\/tasks\/([^/]+)\/context-packs(?:\/([^/?]+))?$/);
  if (request.method === "GET" && contextPackRoute) {
    const taskId = decodeURIComponent(contextPackRoute[1]);
    if (!tasks.findTask(taskId)) return send(response, 404, { error: "Task not found." });
    if (contextPackRoute[2]) {
      const pack = tasks.findContextPack(taskId, decodeURIComponent(contextPackRoute[2]));
      return pack ? send(response, 200, { pack }) : send(response, 404, { error: "Context pack not found." });
    }
    return send(response, 200, { packs: tasks.listContextPacks(taskId) });
  }

  if (request.method === "GET" && request.url === "/api/control/health") {
    return send(response, 200, {
      service: "borg-control-plane",
      version: 1,
      readOnly: true,
      core: "available",
      generatedAt: new Date().toISOString(),
    });
  }

  const controlSnapshotRoute = request.url?.match(/^\/api\/control\/tasks\/([^/?]+)\/snapshot$/);
  if (request.method === "GET" && controlSnapshotRoute) {
    const taskId = decodeURIComponent(controlSnapshotRoute[1]);
    const snapshot = buildDebugSnapshot(taskId);
    return snapshot ? send(response, 200, { snapshot }) : send(response, 404, { error: "Task not found." });
  }

  const controlEventsRoute = request.url?.match(/^\/api\/control\/tasks\/([^/?]+)\/events$/);
  if (request.method === "GET" && controlEventsRoute) {
    const taskId = decodeURIComponent(controlEventsRoute[1]);
    const task = tasks.findTask(taskId);
    if (!task) return send(response, 404, { error: "Task not found." });
    return send(response, 200, {
      taskId,
      events: redactDebugValue(normalizeWorkflowEvents(task, tasks.listEvents(taskId)).slice(-200)),
    });
  }

  const controlExportRoute = request.url?.match(/^\/api\/control\/tasks\/([^/?]+)\/export$/);
  if (request.method === "GET" && controlExportRoute) {
    const taskId = decodeURIComponent(controlExportRoute[1]);
    const snapshot = buildDebugSnapshot(taskId);
    return snapshot ? send(response, 200, {
      bundle: {
        format: "borg-debug-json",
        version: 1,
        filename: `borg-debug-${taskId}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
        snapshot,
      },
    }) : send(response, 404, { error: "Task not found." });
  }

  const controlStreamRoute = request.url?.match(/^\/api\/control\/tasks\/([^/?]+)\/stream$/);
  if (request.method === "GET" && controlStreamRoute) {
    const taskId = decodeURIComponent(controlStreamRoute[1]);
    const task = tasks.findTask(taskId);
    if (!task) return send(response, 404, { error: "Task not found." });
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "http://localhost:5173",
    });
    let lastEventId = tasks.listEvents(taskId).at(-1)?.id ?? null;
    response.write(`event: ready\ndata: ${JSON.stringify({ taskId, generatedAt: new Date().toISOString() })}\n\n`);
    const timer = setInterval(() => {
      if (response.destroyed) return;
      const raw = tasks.listEvents(taskId);
      const index = lastEventId ? raw.findIndex((event) => event.id === lastEventId) : -1;
      const next = index >= 0 ? raw.slice(index + 1) : raw.slice(-50);
      if (next.length) {
        const normalized = normalizeWorkflowEvents(task, next);
        for (const event of normalized) response.write(`event: workflow\ndata: ${JSON.stringify(redactDebugValue(event))}\n\n`);
        lastEventId = next.at(-1)?.id ?? lastEventId;
      } else {
        response.write(`event: heartbeat\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
      }
    }, 2_000);
    request.once("close", () => clearInterval(timer));
    return;
  }

  const workflowEventsRoute = request.url?.match(/^\/api\/tasks\/([^/]+)\/workflow-events$/);
  if (request.method === "GET" && workflowEventsRoute) {
    const taskId = decodeURIComponent(workflowEventsRoute[1]);
    const task = tasks.findTask(taskId);
    if (!task) return send(response, 404, { error: "Task not found." });
    return send(response, 200, { events: normalizeWorkflowEvents(task, tasks.listEvents(taskId)) });
  }

  const workflowStatusRoute = request.url?.match(/^\/api\/tasks\/([^/]+)\/workflow-status$/);
  if (request.method === "GET" && workflowStatusRoute) {
    const taskId = decodeURIComponent(workflowStatusRoute[1]);
    const task = tasks.findTask(taskId);
    if (!task) return send(response, 404, { error: "Task not found." });
    const events = tasks.listEvents(taskId);
    const approval = tasks.findApproval(taskId);
    const root = approval?.worktreePath ?? taskProjectRepository(taskId);
    const projectWorkflow = workflow.get(task.projectId);
    const ownedWorkflow = projectWorkflow?.taskId === task.id ? projectWorkflow : null;
    const plan = projectPlanFromWorkflow(ownedWorkflow, root);
    const slice = sliceStateFromWorkflow(ownedWorkflow, plan, root);
    const baselineCandidates = pendingVisualBaselineCandidates(taskId);
    return send(response, 200, {
      status: deriveWorkflowStatus(task, events, plan, slice, ownedWorkflow, { baselineApprovalCount: baselineCandidates.length }),
      baselineCandidates,
    });
  }

  const changesRoute = request.url?.match(/^\/api\/tasks\/([^/]+)\/changes$/);
  if (request.method === "GET" && changesRoute) {
    const taskId = decodeURIComponent(changesRoute[1]);
    const task = tasks.findTask(taskId);
    const approval = tasks.findApproval(taskId);
    if (!task) return send(response, 404, { error: "Task not found." });
    if (!approval?.worktreePath || approval.status !== "APPROVED") return send(response, 200, { taskId, ...buildChangeLog("", "") });
    void (async () => {
      const context = { taskId };
      const status = await tools.execute({ function: { name: "git_status", arguments: {} } }, "agent", context) as { stdout?: string };
      const diff = await tools.execute({ function: { name: "git_diff", arguments: {} } }, "agent", context) as { stdout?: string };
      const live = buildChangeLog(status.stdout ?? "", diff.stdout ?? "");
      if (!live.clean) return send(response, 200, { taskId, ...live });
      const captured = tasks.listEvents(taskId).findLast((event) => event.type === "CHANGESET_CAPTURED")?.payload as { status?: string; diff?: string } | undefined;
      return send(response, 200, { taskId, ...(captured ? buildChangeLog(captured.status ?? "", captured.diff ?? "") : live) });
    })().catch((error) => send(response, 400, { error: error instanceof Error ? error.message : "Unable to inspect task changes." }));
    return;
  }

  const deliveryRoute = request.url?.match(/^\/api\/tasks\/([^/]+)\/delivery$/);
  if (request.method === "POST" && deliveryRoute) {
    const taskId = decodeURIComponent(deliveryRoute[1]);
    void readJson(request).then(async (input) => {
      let task = tasks.findTask(taskId);
      const approval = tasks.findApproval(taskId);
      if (!task || !approval?.worktreePath || approval.status !== "APPROVED") return send(response, 404, { error: "Verified task worktree not found." });
      if (task.state !== "DELIVERY_READY") return send(response, 409, { error: "Task is not ready for delivery." });
      const blockingFindings = blockingReviewFindings(tasks.listReviewFindings(taskId));
      if (blockingFindings.length) return send(response, 409, { error: "Unresolved high or critical review findings block delivery.", findingIds: blockingFindings.map((value) => value.id) });
      const baselineCandidates = pendingVisualBaselineCandidates(taskId);
      if (baselineCandidates.length) return send(response, 409, {
        code: "VISUAL_BASELINE_APPROVAL_REQUIRED",
        error: `${baselineCandidates.length} verified visual baseline candidate(s) require operator acceptance before delivery.`,
        candidates: baselineCandidates,
      });
      const method = String(input.method ?? "").toLowerCase();
      if (method !== "export" && method !== "commit") return send(response, 400, { error: "Delivery method must be export or commit." });
      const isFrontendSlice = tasks.listEvents(taskId).some((event) => event.type === "FRONTEND_SLICE_SELECTED");
      const repositoryPath = taskProjectRepository(taskId);
      if (isFrontendSlice && !repositoryPath) return send(response, 409, { error: "Project repository is unavailable for saving this slice." });

      const begun = workflow.beginDelivery(task, { method, expectedBaseCommit: approval.baseCommit });
      task = begun.task;
      syncWorkflowProjection(task, begun.workflow);
      try {
        const result = await delivery.deliver(taskId, approval.worktreePath, method, typeof input.message === "string" ? input.message : undefined,
          isFrontendSlice && repositoryPath ? { repositoryPath, expectedBaseCommit: approval.baseCommit! } : undefined);
        const completed = workflow.completeDelivery(task, result);
        task = completed.task;
        syncWorkflowProjection(task, completed.workflow);
        if (isFrontendSlice && repositoryPath && method === "commit") {
          syncDeliveredWorkflowProjection(task, completed.workflow, repositoryPath);
          projectDeliveredFrontendCheckpoint(repositoryPath, completed.workflow);
          commitBuildDocs(repositoryPath, "Project BORG frontend workflow checkpoint");
        }
        return send(response, 200, { task, workflow: completed.workflow, delivery: result });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Delivery failed";
        const failed = workflow.failDelivery(task, message);
        task = failed.task;
        syncWorkflowProjection(task, failed.workflow);
        return send(response, 400, { task, workflow: failed.workflow, error: message });
      }
    }).catch((error) => send(response, 400, { error: error instanceof Error ? error.message : "Invalid delivery request" }));
    return;
  }
  const retryRoute = request.url?.match(/^\/api\/tasks\/([^/]+)\/retry$/);
  if (request.method === "POST" && retryRoute) {
    const taskId = decodeURIComponent(retryRoute[1]);
    const task = tasks.findTask(taskId);
    const approval = tasks.findApproval(taskId);
    if (!task || !approval) return send(response, 404, { error: "Task not found." });
    if (task.state !== "BLOCKED") return send(response, 409, { error: "Only a blocked task can use bounded retry." });
    if (approval.status !== "APPROVED" || !approval.worktreePath || !approval.baseCommit) return send(response, 409, { error: "The blocked task has no approved worktree to recover." });
    void worktrees.inspect(approval.worktreePath, approval.baseCommit).then((inspection) => {
      if (inspection.state === "missing" || inspection.state === "diverged") {
        return send(response, 409, { error: inspection.detail, repositoryState: inspection.state });
      }
      const checkpoint = createCheckpointSnapshot(task, "manual", {
        name: "Operator retry from blocked state",
        mode: recordedMode(task.id),
        contextSummary: "Resume the blocked task in the existing worktree. Repair only the latest evidenced failure.",
      });
      const continuation = createTaskContinuation({
        id: randomUUID(),
        taskId: task.id,
        checkpointId: checkpoint.id,
        parentContinuationId: tasks.listContinuations(task.id).at(-1)?.id ?? null,
        reason: "Operator requested bounded retry of the blocked task.",
        status: "ready",
        restoredMode: recordedMode(task.id) === "agent" ? "agent" : "edit",
        previousState: "BLOCKED",
        resultingState: "IMPLEMENTING",
        repositoryState: inspection.state,
        resumeAction: "inspect_worktree",
        detail: "Reusing the existing approved worktree and resetting only the bounded repair-attempt budget.",
        completed: true,
      });
      const resumed = workflow.continueFromCheckpoint(task, continuation, { resetAttempts: true });
      syncWorkflowProjection(resumed.task, resumed.workflow);
      const sourceFailure = tasks.listEvents(task.id).findLast((event) => event.type === "REPAIR_LIMIT_REACHED" || event.type === "DESIGN_REVIEW_BLOCKED");
      appendTaskEvent(task.id, "BLOCKED_RETRY_REQUESTED", {
        continuationId: continuation.id,
        sourceFailureEventId: sourceFailure?.id ?? null,
        repositoryState: inspection.state,
      });
      return send(response, 200, { task: resumed.task, workflow: resumed.workflow, continuation, checkpoint });
    }).catch((error) => send(response, 400, { error: error instanceof Error ? error.message : "Unable to retry blocked task." }));
    return;
  }

  const executionRoute = request.url?.match(/^\/api\/tasks\/([^/]+)\/execute$/);
  if (request.method === "POST" && executionRoute) {
    const taskId = decodeURIComponent(executionRoute[1]);
    let task = tasks.findTask(taskId);
    const approval = tasks.findApproval(taskId);
    if (!task || !approval) return send(response, 404, { error: "Approved task not found" });
    if (task.state !== "IMPLEMENTING" || approval.status !== "APPROVED" || !approval.worktreePath || !approval.baseCommit) return send(response, 409, { error: "Task is not ready for approved implementation." });
    const approvedWorktreePath = approval.worktreePath;
    response.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache, no-transform",
      "access-control-allow-origin": "http://localhost:5173", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type",
    });
    const taskContext: { taskId: string; executionState?: ExecutionState } = { taskId, executionState: "IMPLEMENT" };
    const emit = (event: Record<string, unknown>) => {
      const enriched = { ...event, taskId };
      writeEvent(response, enriched);
      const eventType = String(event.type ?? "");
      if (eventType.startsWith("tool.") || eventType.startsWith("runtime.turn.")) appendTaskEvent(taskId, eventType.toUpperCase().replaceAll(".", "_"), enriched);
      if (eventType === "activity.updated") appendTaskEvent(taskId, "AGENT_ACTIVITY", { activity: event.activity });
    };
    const performPreflight = (reason: string) => {
      const report = runWorkspacePreflight(approvedWorktreePath, { reason, repair: true, expectedGitHead: approval.baseCommit ?? undefined });
      appendTaskEvent(taskId, "WORKSPACE_PREFLIGHT_COMPLETED", { report });
      emit({ type: "workspace.preflight.completed", report });
      if (!report.passed) {
        appendTaskEvent(taskId, "WORKSPACE_PREFLIGHT_BLOCKED", { report });
        throw new Error(`Workspace preflight blocked execution: ${preflightFailureMessage(report)}`);
      }
      return report;
    };
    const savedPlan = tasks.listEvents(taskId).findLast((event) =>
      event.type === "PLAN_REVISION_MODEL_RESPONSE_COMPLETED" || event.type === "MODEL_RESPONSE_COMPLETED"
    )?.payload.answer;
    const websiteProject = websiteInfo(approvedWorktreePath);
    const persistedDesignBrief = websiteProject ? readPersistedDesignBrief(approvedWorktreePath) : null;
    const parsedPersistedDesignBrief = persistedDesignBrief ? DesignBriefSchema.safeParse(persistedDesignBrief) : null;
    const designBrief = latestDesignBrief(taskId) ?? (parsedPersistedDesignBrief?.success ? parsedPersistedDesignBrief.data : null);
    const designContext = designBrief ? designBriefPrompt(designBrief) : "";
    const taskWorkflow = workflow.get(task.projectId);
    const ownedTaskWorkflow = taskWorkflow?.taskId === task.id ? taskWorkflow : null;
    const authorityProjectId = taskWorkflowAuthorityProjectId(task.id) ?? task.projectId;
    const authorityWorkflow = workflow.get(authorityProjectId);
    const projectPlan = websiteProject ? projectPlanFromWorkflow(authorityWorkflow ?? ownedTaskWorkflow, approvedWorktreePath) : null;
    const executionScopeEvents = tasks.listEvents(taskId);
    const executionMarkers = resolveExecutionScopeMarkers(executionScopeEvents, Boolean(websiteProject));
    const focusedExecutionScope = executionMarkers.focus;
    const focusedBrowserRoute = focusedExecutionScope && projectPlan
      ? (() => {
          const staticRoute = (route: string | null | undefined) =>
            route && route.startsWith("/") && !/[:\[]/.test(route) ? route : null;
          if (focusedExecutionScope.type === "page") {
            return staticRoute(projectPlan.sitemap.find((page) => page.id === focusedExecutionScope.id)?.route);
          }
          const component = projectPlan.components.find((item) => item.id === focusedExecutionScope.id);
          return component?.usedBy
            .map((pageId) => staticRoute(projectPlan.sitemap.find((page) => page.id === pageId)?.route))
            .find((route): route is string => Boolean(route)) ?? null;
        })()
      : null;
    const sliceState = websiteProject && executionMarkers.frontendSliceSelected
      ? sliceStateFromWorkflow(ownedTaskWorkflow, projectPlan, approvedWorktreePath)
      : null;
    const priorDeliveredWebsiteTask = websiteProject
      ? tasks.listTasks(task.projectId).some((candidate) => candidate.id !== taskId && ["DELIVERY_READY", "DELIVERING", "COMPLETE"].includes(candidate.state))
      : false;
    const executionScope = resolveExecutionTaskScope({
      events: executionScopeEvents,
      hasWebsite: Boolean(websiteProject),
      hasProjectPlan: Boolean(projectPlan),
      hasSliceState: Boolean(sliceState),
      priorDeliveredWebsiteTask,
    });
    const styleWorkspace = executionScope.styleWorkspace;
    const websiteWorkflow = executionScope.websiteWorkflow;
    const websiteContext = websiteProject ? websiteGenerationContext({
      name: websiteProject.name,
      template: websiteProject.template,
      originalBrief: websiteProject.originalBrief,
    }, websiteWorkflow) : "";
    const backendHandoff = executionScope.backendPhase
      ? `Plan and implement backend work from the completed frontend contract. Preserve the frontend.\n${ownedTaskWorkflow?.handoff ?? readProjectDocs(approvedWorktreePath).filter((doc) => /\/(data-contract|handoff|decisions)\.md$/.test(doc.path)).map((doc) => `${doc.path}\n${doc.content.slice(0, 4000)}`).join("\n\n").slice(0, 12_000)}` : "";
    const styleExecutionContext = styleWorkspace && websiteProject
      ? "GLOBAL STYLE WORKSPACE. Preserve sitemap, routes, page purposes, component responsibilities, content hierarchy, interactions, and data behavior. Change shared visual primitives first: theme/tokens, typography, spacing, radii, shadows, layout rhythm, responsive styling, motion, and accessibility presentation. Avoid one-off component patches when a shared rule can solve the request. Verify representative pages at mobile and desktop widths."
      : "";
    const teamPolicy = teamPolicies.load(taskProjectRepository(taskId));
    const activeDisciplines = (task.disciplines.length ? task.disciplines : [teamPolicy.defaultDiscipline]) as EngineeringDiscipline[];
    const primaryDiscipline = activeDisciplines[0];
    const packs = selectSpecialistPacks(activeDisciplines);
    const specialistInstructions = {
      implementer: specialistSystemInstructions(packs, "implementer"),
      verifier: specialistSystemInstructions(packs, "verifier"),
      reviewer: specialistSystemInstructions(packs, "reviewer"),
    };
    const availableImplementationTools = tools.toolDefinitions("agent", taskContext, "implementer", activeDisciplines).map((tool) => tool.function.name);
    const verificationProfile = verificationProfileFor(packs);
    let activeRoleAssignment: RoleAssignment | null = null;
    void (async () => {
      const taskEvents = tasks.listEvents(taskId);
      const blockedRetry = taskEvents.findLast((event) => event.type === "BLOCKED_RETRY_REQUESTED");
      const blockedFailure = blockedRetry
        ? taskEvents.findLast((event) =>
            event.type === "REPAIR_LIMIT_REACHED"
            || event.type === "DESIGN_REVIEW_BLOCKED"
            || event.type === "DESIGN_REFINEMENT_LIMIT_REACHED"
            || event.type === "PLAN_REPAIR_REQUIRED")
        : null;
      let repairEvidence = blockedRetry
        ? `OPERATOR BLOCKED-TASK RETRY. Continue in the existing worktree. Repair only the latest failure; do not restart implementation or rediscover the repository.\n\nLatest failure evidence:\n${JSON.stringify(blockedFailure?.payload ?? {}).slice(0, 60_000)}`
        : "";
      let executionState: ExecutionState = blockedRetry ? "REPAIR" : "IMPLEMENT";
      taskContext.executionState = executionState;
      const setExecutionState = (next: ExecutionState) => {
        if (next !== executionState) assertExecutionTransition(executionState, next);
        executionState = next;
        taskContext.executionState = next;
        appendTaskEvent(taskId, "EXECUTION_STATE_CHANGED", { state: next, repairAttempt: task?.attempts ?? 0 });
        emit({ type: "execution.state.changed", state: next, repairAttempt: task?.attempts ?? 0 });
      };
      let implementationBudgetContinuations = 0;
      let implementationBudgetExhausted = false;
      appendTaskEvent(taskId, "EXECUTION_STATE_CHANGED", { state: executionState, repairAttempt: task.attempts });
      performPreflight("execution_start");
      const contextHintRoot = taskProjectRepository(taskId) ?? approvedWorktreePath;
      const contextWorkflowVersion = authorityWorkflow?.version ?? ownedTaskWorkflow?.version ?? null;
      const selectedSlice = sliceState && projectPlan ? projectPlan.slices[sliceState.current] ?? null : null;
      const focusedEntity = focusedExecutionScope && projectPlan
        ? (focusedExecutionScope.type === "page"
            ? projectPlan.sitemap.find((item) => item.id === focusedExecutionScope.id)
            : projectPlan.components.find((item) => item.id === focusedExecutionScope.id))
        : null;
      const compiledSlice = sliceState && projectPlan && selectedSlice ? compileFrontendContext({
        root: approvedWorktreePath,
        phase: "frontend",
        sliceIndex: sliceState.current,
        authority: { plan: projectPlan, state: sliceState, workflowVersion: contextWorkflowVersion },
        productContract: websiteContext,
        projectBrief: websiteProject?.originalBrief ?? undefined,
        sourceHints: contextSourceHints(contextHintRoot, [task.request, selectedSlice.title, selectedSlice.outcome, ...selectedSlice.scope].join(" ")),
        stage: taskContext.executionState === "REPAIR" ? "repair" : "execution",
      }) : null;
      const compiledFocus = focusedExecutionScope && projectPlan ? compileFocusedFrontendContext({
        root: approvedWorktreePath,
        scope: focusedExecutionScope,
        productContract: websiteContext,
        projectBrief: websiteProject?.originalBrief ?? undefined,
        sourceHints: contextSourceHints(contextHintRoot, [task.request, focusedEntity?.name ?? "", focusedEntity?.purpose ?? ""].join(" ")),
        stage: taskContext.executionState === "REPAIR" ? "repair" : "execution",
        authority: { plan: projectPlan, workflowVersion: contextWorkflowVersion },
      }) : null;
      const compiledStyle = styleWorkspace && projectPlan ? compileStyleFrontendContext({
        root: approvedWorktreePath,
        productContract: websiteContext,
        projectBrief: websiteProject?.originalBrief ?? undefined,
        sourceHints: contextSourceHints(contextHintRoot, `global styles theme typography spacing color layout responsive motion ${task.request}`),
        stage: taskContext.executionState === "REPAIR" ? "repair" : "execution",
        authority: { plan: projectPlan, workflowVersion: contextWorkflowVersion },
      }) : null;
      const compiledExecutionContext = compiledFocus ?? compiledStyle ?? compiledSlice;
      if (compiledExecutionContext) recordContextPack(taskId, authorityProjectId, compiledExecutionContext);
      const activeSlicePrompt = sliceState && projectPlan ? `${slicePrompt(projectPlan, sliceState, availableImplementationTools)}\n\n${compiledSlice?.text ?? ""}` : "";
      const focusedExecutionPrompt = compiledFocus
        ? `FOCUSED ${focusedExecutionScope!.type.toUpperCase()} WORKSPACE [${focusedExecutionScope!.id}]. Modify only the selected ${focusedExecutionScope!.type} and direct dependencies represented in the focused context. Preserve unrelated pages/components and the approved global style system. Do not perform repository-wide redesign or planning.\n\n${compiledFocus.text}`
        : "";
      const styleExecutionPrompt = compiledStyle
        ? `${styleExecutionContext}\n\n${compiledStyle.text}`
        : styleExecutionContext;
      while (task) {
        if (task.attempts > 0) performPreflight("retry_start");
        const attemptStartedInRepair = taskContext.executionState === "REPAIR";
        const preAttemptSnapshot = sourceMutationSnapshot(approvedWorktreePath);
        const implementerModel = teamPolicies.modelFor(teamPolicy, "implementer", model, primaryDiscipline);
        activeRoleAssignment = beginRole(task, "implementer", primaryDiscipline, implementerModel, packs, emit);
        const repairGrounding = attemptStartedInRepair ? repairGroundingSnapshot(approvedWorktreePath) : "";
        const repairPrompt = repairEvidence
          ? [repairEvidence, repairGrounding].filter(Boolean).join("\n\n")
          : `Approved plan:\n${typeof savedPlan === "string" ? savedPlan : "No saved plan text was found; inspect the repository and implement conservatively."}`;
        let implementationResult: Awaited<ReturnType<typeof runOllamaAgent>>;
        try {
          implementationResult = await runOllamaAgent({
          ollamaUrl, model: implementerModel, tools, mode: "agent", taskContext, role: "implementer", disciplines: activeDisciplines, phase: "implementation", emit,
          limits: sliceState || focusedExecutionScope || styleWorkspace ? { toolRounds: 12, toolCalls: 28 } : undefined,
          onRequestBody: websiteProject ? (body) => recordModelInput(taskId, "implementer", implementerModel, compiledExecutionContext?.sliceId ?? null, compiledExecutionContext?.manifest ?? [], body) : undefined,
          messages: [
            ...(taskContext.executionState === "REPAIR" ? [{ role: "system" as const, content: "You are BORG's bounded repair agent. Resolve only the supplied failure evidence. Do not restart planning or perform repository-wide discovery. Inspect only implicated files and direct dependencies, make the smallest root-cause correction, and return control to deterministic verification." }] : []),
            { role: "system", content: `${activeSlicePrompt ? activeSlicePrompt + "\n\n" : ""}${focusedExecutionPrompt ? focusedExecutionPrompt + "\n\n" : ""}${styleExecutionPrompt ? styleExecutionPrompt + "\n\n" : ""}${backendHandoff ? backendHandoff + "\n\n" : ""}You are BORG's approved implementation agent. Work only inside the task worktree through the provided worktree tools. Create new files with worktree_write; it safely creates missing parent directories. Use worktree_patch for exact edits to existing files. Inspect Git status and diff; run relevant bounded commands when useful. For web-interface tasks, call browser_server_start to reuse the managed live preview, then use the URL it returns for browser_open and browser_responsive. Do not guess a fixed port or run a development server through worktree_command. Inspect and interact with the site through browser tools, and capture responsive screenshots, console/network failures, DOM evidence, and accessibility results. The development server is shared with the desktop Preview, so leave it running unless it crashes or an explicit restart is required; browser_close is enough to end the Chromium verification session. Browser verification is loopback-only and its latest report is attached to deterministic verification and fresh review. Use activity_update to keep the user informed in plain English: before each meaningful block of work, state what you are doing and which subsystem or files you expect to touch; report important discoveries that change your approach; after a meaningful mutation, explain what you changed; and before verification, say what you are checking. Do not emit activity updates for every trivial read, search, or tool call. The activity files field describes expected/current work context only; do not claim a file actually changed until runtime evidence proves it. Do not claim a mutation or verification that a tool result does not prove. The server will run deterministic verification after your work.\n\nActive specialist capability packs:\n${specialistInstructions.implementer}${designContext ? "\n\n" + designContext : ""}${websiteContext && !compiledExecutionContext ? "\n\n" + websiteContext : ""}\n\nApproved worktree: ${approval.worktreePath}\nImmutable base commit: ${approval.baseCommit}` },
            { role: "user", content: `Implement this approved request:\n${task.request}\n\n${repairPrompt}` },
          ],
          });
        } catch (error) {
          if (activeRoleAssignment) finishRole(activeRoleAssignment, "failed", emit);
          activeRoleAssignment = null;
          const decision = classifyImplementationFailure(error, task.attempts, maxRepairAttempts);
          appendTaskEvent(taskId, "IMPLEMENTATION_FAILURE_CLASSIFIED", { decision, phase: "implementation" });
          if (decision.disposition === "fatal") {
            syncWorkflowProjection(task, workflow.recovery(task, decision.category, decision.action, true));
            throw error;
          }
          const recoveryPreflight = performPreflight("implementation_recovery");
          repairEvidence = compactRecoveryEvidence(decision, recoveryPreflight);
          task = scheduleImplementationRetry(task, emit, decision.action, decision);
          continue;
        }
        const { answer, usedTools, budgetExhausted } = implementationResult;
        implementationBudgetExhausted = Boolean(budgetExhausted);
        if (sliceState || focusedExecutionScope || styleWorkspace) {
          const progressStatus = await tools.execute({ function: { name: "git_status", arguments: {} } }, "agent", taskContext, "implementer", activeDisciplines) as { stdout?: string };
          const postAttemptSnapshot = sourceMutationSnapshot(approvedWorktreePath);
          const initialSourceProgress = (progressStatus.stdout ?? "").split(/\r?\n/).filter(Boolean).some((line) => !line.includes(".localcode/build/"));
          const repairDelta = preAttemptSnapshot.fingerprint !== postAttemptSnapshot.fingerprint;
          const explainedNoMutation = /\b(?:no (?:source )?(?:change|mutation) (?:is )?required because|no mutation needed because|already resolved and no (?:source )?change is required)\b/i.test(answer);
          const sourceProgress = attemptStartedInRepair ? repairDelta || explainedNoMutation : initialSourceProgress;
          if (attemptStartedInRepair && !repairDelta && explainedNoMutation) {
            appendTaskEvent(taskId, "REPAIR_NO_MUTATION_EXPLAINED", { attempt: task.attempts, answer: answer.slice(0, 4_000) });
          }
          if (!sourceProgress) {
            if (activeRoleAssignment) finishRole(activeRoleAssignment, "failed", emit);
            activeRoleAssignment = null;
            const toolFailures = tasks.listEvents(taskId)
              .filter((event) => event.type === "TOOL_FAILED")
              .slice(-5)
              .map((event) => {
                const payload = event.payload as Record<string, unknown>;
                return String(payload.message ?? JSON.stringify(payload)).slice(0, 2_000);
              });
            const failure = toolFailures.at(-1) ?? (attemptStartedInRepair
              ? "The repair attempt completed without changing the source diff relative to the start of this repair pass."
              : "The implementation attempt completed without any source-file progress.");
            const decision = classifyImplementationFailure(failure, task.attempts, maxRepairAttempts, { noProgress: true });
            appendTaskEvent(taskId, attemptStartedInRepair ? "REPAIR_NO_PROGRESS" : "IMPLEMENTATION_NO_PROGRESS", {
              attempt: task.attempts,
              toolFailures,
              decision,
              preAttemptFingerprint: preAttemptSnapshot.fingerprint,
              postAttemptFingerprint: postAttemptSnapshot.fingerprint,
            });
            appendTaskEvent(taskId, "IMPLEMENTATION_FAILURE_CLASSIFIED", { decision, phase: "implementation" });
            if (decision.disposition === "fatal") {
              syncWorkflowProjection(task, workflow.recovery(task, decision.category, decision.action, true));
              throw new Error(`Slice recovery stopped: ${decision.reason}`);
            }
            const recoveryPreflight = performPreflight("no_progress_recovery");
            repairEvidence = compactRecoveryEvidence(decision, recoveryPreflight, toolFailures);
            task = scheduleImplementationRetry(task, emit, decision.action, decision);
            continue;
          }
        }
        if ((sliceState || focusedExecutionScope || styleWorkspace) && budgetExhausted && implementationBudgetContinuations < 1) {
          implementationBudgetContinuations += 1;
          appendTaskEvent(taskId, "IMPLEMENTATION_BUDGET_CONTINUATION", {
            continuation: implementationBudgetContinuations,
            toolBudgetExhausted: true,
          });
          if (activeRoleAssignment) finishRole(activeRoleAssignment, "completed", emit);
          activeRoleAssignment = null;
          repairEvidence = focusedExecutionScope
            ? `The bounded implementation tool budget ended before the focused ${focusedExecutionScope.type} edit demonstrated completion. Continue the SAME focused scope [${focusedExecutionScope.id}] from the current worktree state. Do not re-plan or inspect unrelated pages/components.`
            : styleWorkspace
              ? "The bounded implementation tool budget ended before the global style edit demonstrated completion. Continue the SAME style task from the current worktree state without changing site structure."
              : "The bounded implementation tool budget ended before the slice could explicitly demonstrate completion. Continue the SAME approved slice from the current worktree state. Do not re-plan or rediscover the project. Inspect only the changed/relevant files, finish any remaining acceptance criteria, and leave evidence for verification.";
          emit({ type: "runtime.notice", message: "Implementation reached its bounded tool budget. Continuing the same scoped task once with compact context instead of treating partial progress as complete." });
          continue;
        }
        if ((sliceState || focusedExecutionScope || styleWorkspace) && budgetExhausted) appendTaskEvent(taskId, "IMPLEMENTATION_BUDGET_EXHAUSTED", { continuations: implementationBudgetContinuations });
        appendTaskEvent(taskId, task.attempts > 0 ? "REPAIR_RESPONSE_COMPLETED" : "IMPLEMENTATION_RESPONSE_COMPLETED", { runtime: "ollama", model: implementerModel, role: "implementer", answer, usedTools, budgetExhausted: Boolean(budgetExhausted), attempt: task.attempts });
        finishRole(activeRoleAssignment, "completed", emit);
        recordHandoff({
          task,
          fromRole: "implementer",
          toRole: "verifier",
          objective: task.request,
          completedWork: [task.attempts > 0 ? `Repair attempt ${task.attempts} completed.` : "Approved implementation completed."],
          evidence: [`Implementation response recorded with ${usedTools ? "tool use" : "no tool use"}.`],
          constraints: packs.flatMap((pack) => pack.riskRules),
          requiredNextAction: `Run the ${verificationProfile} deterministic profile and collect: ${packs.flatMap((pack) => pack.requiredEvidence).join(" ")}`,
        }, emit);
        const verifierModel = teamPolicies.modelFor(teamPolicy, "verifier", model, primaryDiscipline);
        activeRoleAssignment = beginRole(task, "verifier", primaryDiscipline, verifierModel, packs, emit);
        setExecutionState("VERIFY");
        task = transitionTask(task, "VERIFYING", emit);
        if (sliceState && projectPlan) setFrontendWorkflowStage(approvedWorktreePath, "slice_verifying", { currentSlice: sliceState.current, totalSlices: projectPlan.slices.length, taskId, detail: "Implementation produced source changes. Deterministic and browser verification are running." });
        emit({ type: "stage.updated", stage: "Verification", status: "active" });
        emit({ type: "tool.started", tool: "verification_run", input: { profile: verificationProfile } });
        let deterministicVerification: {
          passed?: boolean;
          results?: Array<{ label?: string; command?: string; args?: string[]; exitCode?: number; stdout?: string; stderr?: string }>;
          browserEvidence?: BrowserEvidenceReport | null;
          visualRegression?: VisualRegressionReport;
        };
        try {
          deterministicVerification = await tools.execute(
            { function: { name: "verification_run", arguments: { profile: verificationProfile } } },
            "agent", taskContext, "verifier", activeDisciplines,
          ) as typeof deterministicVerification;
        } catch (error) {
          if (activeRoleAssignment) finishRole(activeRoleAssignment, "failed", emit);
          activeRoleAssignment = null;
          const decision = classifyImplementationFailure(error, task.attempts, maxRepairAttempts);
          appendTaskEvent(taskId, "IMPLEMENTATION_FAILURE_CLASSIFIED", { decision, phase: "verification" });
          if (decision.disposition === "fatal") {
            syncWorkflowProjection(task, workflow.recovery(task, decision.category, decision.action, true));
            throw error;
          }
          const recoveryPreflight = performPreflight("verification_recovery");
          repairEvidence = compactRecoveryEvidence(decision, recoveryPreflight);
          setExecutionState("REPAIR");
          task = scheduleRepair(task, emit, decision.action, decision);
          continue;
        }
        let focusedBrowserEvidence: BrowserEvidenceReport | null = null;
        let focusedBrowserFailure: string | null = null;
        if (focusedBrowserRoute) {
          const serverUrl = processRuntime.findRunning(taskId, "dev_server")?.url;
          if (!serverUrl) {
            focusedBrowserFailure = "Focused route verification requires the managed development server.";
          } else {
            const focusedUrl = new URL(focusedBrowserRoute, serverUrl).toString();
            try {
              await tools.execute(
                { function: { name: "browser_responsive", arguments: { url: focusedUrl, accessibility: true } } },
                "agent", taskContext, "verifier", activeDisciplines,
              );
              const closed = await tools.execute(
                { function: { name: "browser_close", arguments: {} } },
                "agent", taskContext, "verifier", activeDisciplines,
              ) as { report?: BrowserEvidenceReport | null };
              focusedBrowserEvidence = closed.report ?? null;
              appendTaskEvent(taskId, "FOCUSED_BROWSER_VERIFICATION_COMPLETED", {
                scope: focusedExecutionScope,
                route: focusedBrowserRoute,
                passed: focusedBrowserEvidence?.passed ?? false,
              });
            } catch (error) {
              focusedBrowserFailure = error instanceof Error ? error.message : String(error);
              appendTaskEvent(taskId, "FOCUSED_BROWSER_VERIFICATION_FAILED", {
                scope: focusedExecutionScope,
                route: focusedBrowserRoute,
                message: focusedBrowserFailure,
              });
            }
          }
        }
        const verificationEvidence = focusedBrowserEvidence
          ? { ...deterministicVerification, browserEvidence: focusedBrowserEvidence }
          : deterministicVerification;
        const specialistEvidence = evaluateSpecialistEvidence(packs, verificationEvidence);
        const verification = {
          ...deterministicVerification,
          browserEvidence: focusedBrowserEvidence ?? deterministicVerification.browserEvidence,
          focusedBrowserRoute,
          focusedBrowserFailure,
          passed: Boolean(deterministicVerification.passed)
            && !focusedBrowserFailure
            && (focusedBrowserEvidence?.passed ?? true)
            && specialistEvidence.passed,
          specialistEvidence,
          specialistInstructions: specialistInstructions.verifier,
        };
        emit({ type: "tool.completed", tool: "verification_run", output: verification });
        const verificationFailure = [
          ...(verification.browserEvidence?.issues ?? []),
          ...(verification.specialistEvidence?.failures ?? []),
        ].filter(Boolean).join(" ") || "Deterministic verification failed.";
        const verificationSummary = verification.passed
          ? `${verificationProfile} verification passed for repair attempt ${task.attempts}.`
          : verificationFailure;
        const verifiedWorkflow = workflow.recordVerification(task, {
          passed: verification.passed,
          attempt: task.attempts,
          profile: verificationProfile,
          summary: verificationSummary,
          browserPassed: verification.browserEvidence?.passed ?? (focusedBrowserFailure ? false : null),
          specialistPassed: verification.specialistEvidence?.passed ?? null,
          resultSha256: createHash("sha256").update(JSON.stringify(verification)).digest("hex"),
          evidence: verification,
        });
        syncWorkflowProjection(task, verifiedWorkflow);
        if (verification.visualRegression && verification.visualRegression.status !== "disabled") {
          appendTaskEvent(taskId, "VISUAL_REGRESSION_COMPLETED", { report: verification.visualRegression, attempt: task.attempts });
          emit({ type: "visual.regression.completed", visualRegression: verification.visualRegression });
        }
        if (!verification.passed) {
          finishRole(activeRoleAssignment, "completed", emit);
          recordHandoff({
            task,
            fromRole: "verifier",
            toRole: "implementer",
            objective: task.request,
            evidence: [JSON.stringify(verification).slice(0, 20_000)],
            openRisks: [verificationFailure],
            requiredNextAction: "Repair only the evidenced verification failure.",
          }, emit);
          activeRoleAssignment = null;
          emit({ type: "stage.updated", stage: "Verification", status: "failed" });
          if (task.attempts >= maxRepairAttempts) {
            setExecutionState("BLOCKED");
            task = transitionTask(task, "BLOCKED", emit);
            appendTaskEvent(taskId, "REPAIR_LIMIT_REACHED", { attempts: task.attempts, verification });
            emit({ type: "stream.blocked", message: `Verification still failed after ${maxRepairAttempts} repair attempts. Changes remain isolated for inspection.` });
            response.end();
            return;
          }
          const status = await tools.execute({ function: { name: "git_status", arguments: {} } }, "agent", taskContext, "verifier", activeDisciplines) as { stdout?: string };
          const recentChanges = (status.stdout ?? "").split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).trim());
          const context = buildRepairContext({ sliceId: compiledFocus?.sliceId ?? compiledSlice?.sliceId, attempt: task.attempts, results: deterministicVerification.results, recentChanges });
          repairEvidence = `${formatRepairContext(context)}\n\nBrowser and specialist evidence:\n${JSON.stringify({ browserEvidence: verification.browserEvidence, specialistEvidence: verification.specialistEvidence }).slice(0, 40_000)}`;
          appendTaskEvent(taskId, "REPAIR_CONTEXT_CREATED", { context });
          setExecutionState("REPAIR");
          task = scheduleRepair(task, emit, verificationFailure);
          continue;
        }

        let visionReview: VisionReviewResult | null = null;
        if (verification.browserEvidence && !designBrief) {
          setExecutionState("BROWSER_VERIFY");
          const visionStatus = vision.status();
          appendTaskEvent(taskId, "VISION_REVIEW_STARTED", { provider: visionStatus.provider, model: visionStatus.model, attempt: task.attempts });
          emit({ type: "vision.review.started", provider: visionStatus.provider, model: visionStatus.model });
          visionReview = await vision.review({
            taskId,
            request: task.request,
            worktreePath: approvedWorktreePath,
            browserEvidence: verification.browserEvidence,
            onRequestBody: (body) => recordModelInput(taskId, "vision_reviewer", visionStatus.model, compiledSlice?.sliceId ?? null, [], body),
          });
          const visionEvent = visionReview.status === "unavailable" ? "VISION_REVIEW_UNAVAILABLE"
            : visionReview.status === "failed" ? "VISION_REVIEW_FAILED"
            : visionReview.status === "inconclusive" ? "VISION_REVIEW_INCONCLUSIVE"
            : visionReview.status === "disabled" ? "VISION_REVIEW_DISABLED"
            : "VISION_REVIEW_COMPLETED";
          appendTaskEvent(taskId, visionEvent, { review: visionReview, attempt: task.attempts });
          emit({ type: "vision.review.completed", visionReview });
          if (visionReview.status === "repair") {
            finishRole(activeRoleAssignment, "completed", emit);
            recordHandoff({
              task,
              fromRole: "verifier",
              toRole: "implementer",
              objective: task.request,
              evidence: [JSON.stringify(visionReview).slice(0, 20_000)],
              openRisks: ["Local vision review found a blocking visual defect."],
              requiredNextAction: "Repair only the evidenced visual defect.",
            }, emit);
            activeRoleAssignment = null;
            recordCompletedReview(task, visionReview.findings, "repair", "Local vision review found a blocking visual defect.");
            emit({ type: "review.history.updated" });
            emit({ type: "stage.updated", stage: "Verification", status: "failed" });
            if (task.attempts >= maxRepairAttempts) {
              setExecutionState("BLOCKED");
              task = transitionTask(task, "BLOCKED", emit);
              appendTaskEvent(taskId, "REPAIR_LIMIT_REACHED", { attempts: task.attempts, visionReview });
              emit({ type: "stream.blocked", message: `Local vision review still found a blocking visual defect after ${maxRepairAttempts} repair attempts.` });
              response.end();
              return;
            }
            repairEvidence = `Local vision review requires repair:\n${JSON.stringify(visionReview).slice(0, 60_000)}`;
            setExecutionState("REPAIR");
            task = scheduleRepair(task, emit, "Local vision review found a blocking visual defect.");
            continue;
          }
        }

        let designReview: DesignReviewResult | null = null;
        if (designBrief) {
          setExecutionState("BROWSER_VERIFY");
          if (!verification.browserEvidence) {
            finishRole(activeRoleAssignment, "completed", emit);
            activeRoleAssignment = null;
            appendTaskEvent(taskId, "DESIGN_REVIEW_BLOCKED", { reason: "Missing browser evidence.", attempt: task.attempts });
            setExecutionState("BLOCKED");
            task = transitionTask(task, "BLOCKED", emit);
            emit({ type: "design.review.blocked", message: "Premium frontend delivery requires responsive browser screenshots for aesthetic review." });
            emit({ type: "stream.blocked", message: "Design quality could not be verified because responsive browser evidence is missing." });
            response.end();
            return;
          }
          const policy = vision.status();
          emit({ type: "stage.updated", stage: "Visual Direction", status: "active" });
          appendTaskEvent(taskId, "DESIGN_REVIEW_STARTED", { provider: policy.provider, model: policy.model, attempt: task.attempts });
          emit({ type: "design.review.started", provider: policy.provider, model: policy.model });
          const visualReviewSlice = sliceState && projectPlan ? projectPlan.slices[sliceState.current] ?? null : null;
          designReview = await visualDirector.review({
            taskId,
            request: [task.request, activeSlicePrompt].filter(Boolean).join("\n\n"),
            worktreePath: approvedWorktreePath,
            browserEvidence: verification.browserEvidence,
            brief: designBrief,
            policy,
            scope: {
              currentSlice: visualReviewSlice ? {
                id: visualReviewSlice.id,
                title: visualReviewSlice.title,
                outcome: visualReviewSlice.outcome,
                scope: visualReviewSlice.scope,
              } : null,
              projectPages: projectPlan?.sitemap.map((page) => ({ id: page.id, name: page.name, route: page.route })) ?? [],
            },
            onRequestBody: (body) => recordModelInput(taskId, "visual_director", policy.model, compiledSlice?.sliceId ?? null, [], body),
          });
          appendTaskEvent(taskId, designReview.status === "pass" || designReview.status === "repair" ? "DESIGN_REVIEW_COMPLETED" : "DESIGN_REVIEW_BLOCKED", {
            review: designReview,
            attempt: task.attempts,
          });
          emit({ type: "design.review.completed", designReview });

          if (designReview.status === "repair") {
            finishRole(activeRoleAssignment, "completed", emit);
            activeRoleAssignment = null;
            emit({ type: "stage.updated", stage: "Visual Direction", status: "failed" });

            const requiresPlanRevision = designReview.repairScope === "cross_slice" || designReview.repairScope === "project_plan";
            if (requiresPlanRevision) {
              if (!projectPlan || !sliceState || !websiteProject) {
                setExecutionState("BLOCKED");
                task = transitionTask(task, "BLOCKED", emit);
                appendTaskEvent(taskId, "PLAN_REPAIR_REQUIRED", {
                  reason: designReview.scopeReason || designReview.summary,
                  review: designReview,
                  error: "Durable project plan or active slice was unavailable for automatic plan revision.",
                });
                emit({ type: "stream.blocked", message: "The Visual Director requires a plan-level repair, but BORG could not resolve the durable active plan/slice needed to revise it safely." });
                response.end();
                return;
              }

              const revisionReason = designReview.scopeReason || designReview.summary;
              const checkpoint = createCheckpointSnapshot(task, "pre_repair");
              const recovered = workflow.markRecoveryRequired(task, {
                category: "plan_repair_required",
                checkpointId: checkpoint.id,
                resumeAction: "replan",
                reason: revisionReason,
              });
              task = recovered.task;
              syncWorkflowProjection(task, recovered.workflow);
              appendTaskEvent(taskId, "DESIGN_SCOPE_CONFLICT", {
                review: designReview,
                repairScope: designReview.repairScope,
                reason: revisionReason,
                currentSliceIndex: sliceState.current,
                currentSliceId: projectPlan.slices[sliceState.current]?.id ?? null,
              });
              appendTaskEvent(taskId, "PLAN_REPAIR_REQUIRED", {
                reason: revisionReason,
                repairScope: designReview.repairScope,
                review: designReview,
                checkpointId: checkpoint.id,
              });

              const revising = workflow.beginPlanRevision(task, revisionReason);
              task = revising.task;
              syncWorkflowProjection(task, revising.workflow);
              setExecutionState("BLOCKED");
              emit({ type: "stage.updated", stage: "Plan", status: "active", message: "The current slice cannot satisfy the product-quality review. Revising the project plan without discarding the existing worktree." });

              const revisionModel = teamPolicies.modelFor(teamPolicy, "architect", model, primaryDiscipline);
              const revisionAssignment = beginRole(task, "architect", primaryDiscipline, revisionModel, packs, emit);
              const revisionBrief = websiteProject.originalBrief || task.request;
              const revisionRequest = {
                ollamaUrl,
                model: revisionModel,
                tools,
                mode: "plan" as const,
                role: "architect" as const,
                disciplines: activeDisciplines,
                phase: "plan" as const,
                emit,
                limits: { toolRounds: 3, toolCalls: 4 },
                onRequestBody: (body: string) => recordModelInput(taskId, "architect", revisionModel, `plan-revision:${projectPlan.revision + 1}`, [], body),
                messages: [
                  {
                    role: "system" as const,
                    content: "You are BORG's bounded project-plan repair architect. Revise planning authority only. Do not mutate source, run commands, restart repository discovery, or discard already-completed work. The original brief, durable current plan, active slice, and independent review evidence below are authoritative.",
                  },
                  {
                    role: "user" as const,
                    content: projectPlanRevisionPrompt({
                      brief: revisionBrief,
                      currentPlan: projectPlan,
                      currentSliceIndex: sliceState.current,
                      conflictReason: revisionReason,
                      review: designReview,
                    }),
                  },
                ],
              };

              let revisionResult = await runOllamaAgent(revisionRequest);
              let parsedRevision = parseProjectPlanResult(revisionResult.answer, revisionBrief, websiteProject.template);
              if (parsedRevision.source === "fallback") {
                appendTaskEvent(taskId, "PROJECT_PLAN_REVISION_SEMANTIC_RETRY", {
                  reason: parsedRevision.fallbackReason,
                  validation: parsedRevision.validation,
                });
                revisionResult = await runOllamaAgent({
                  ...revisionRequest,
                  messages: [
                    ...revisionRequest.messages,
                    { role: "assistant" as const, content: revisionResult.answer },
                    { role: "user" as const, content: projectPlanRepairPrompt(parsedRevision) },
                  ],
                  limits: { toolRounds: 2, toolCalls: 2 },
                });
                parsedRevision = parseProjectPlanResult(revisionResult.answer, revisionBrief, websiteProject.template);
              }

              if (parsedRevision.source === "fallback" || !parsedRevision.validation.valid) {
                finishRole(revisionAssignment, "failed", emit);
                const failureReason = `Plan revision failed semantic validation: ${parsedRevision.fallbackReason ?? parsedRevision.validation.issues.join(" ")}`;
                const failedRevision = workflow.markRecoveryRequired(task, {
                  category: "plan_repair_required",
                  checkpointId: checkpoint.id,
                  resumeAction: "replan",
                  reason: failureReason,
                });
                task = failedRevision.task;
                syncWorkflowProjection(task, failedRevision.workflow);
                appendTaskEvent(taskId, "PLAN_REVISION_FAILED", {
                  reason: failureReason,
                  validation: parsedRevision.validation,
                });
                emit({ type: "stream.blocked", message: failureReason });
                response.end();
                return;
              }

              const planWorkflow = workflow.setProjectPlan(task, parsedRevision.plan);
              syncWorkflowProjection(task, planWorkflow);
              const proposedPlan = planWorkflow.projectPlan as ProjectPlan;
              const coverage = validateProjectPlanCoverage(proposedPlan, revisionBrief);
              if (!coverage.valid) throw new Error(`Core plan revision failed coverage after parse validation: ${coverage.issues.join(" ")}`);
              const delta = projectPlanDelta(projectPlan, proposedPlan);
              persistProposedProjectPlan(approvedWorktreePath, revisionBrief, proposedPlan, taskId, {
                coverage,
                currentSlice: planWorkflow.planRevisionResumeIndex ?? sliceState.current,
                revisionReason,
              });
              appendTaskEvent(taskId, "PROJECT_PLAN_COVERAGE_VALIDATED", {
                revision: proposedPlan.revision,
                coverage,
                planRevision: true,
              });
              appendTaskEvent(taskId, "PROJECT_PLAN_REVISION_PROPOSED", {
                plan: proposedPlan,
                delta,
                repairScope: designReview.repairScope,
                reason: revisionReason,
                workflowVersion: planWorkflow.version,
              });
              appendTaskEvent(taskId, "PLAN_REVISION_MODEL_RESPONSE_COMPLETED", {
                runtime: "ollama",
                model: revisionModel,
                role: "architect",
                answer: revisionResult.answer,
                usedTools: revisionResult.usedTools,
              });
              finishRole(revisionAssignment, "completed", emit);
              writeEvent(response, { type: "message.delta", taskId, text: revisionResult.answer });

              const revisionApproval = {
                ...createApproval({ id: randomUUID(), taskId }),
                worktreePath: approval.worktreePath,
                baseCommit: approval.baseCommit,
              };
              const requestedRevision = workflow.requestApproval(task, revisionApproval, "project_plan_revision");
              task = requestedRevision.task;
              syncWorkflowProjection(task, requestedRevision.workflow);
              emit({ type: "task.state", taskId, state: task.state, workflow: requestedRevision.workflow });
              writeEvent(response, {
                type: "project.plan.approval.requested",
                taskId,
                approval: revisionApproval,
                planText: revisionResult.answer,
                projectPlan: proposedPlan,
                planRevision: true,
                planDelta: delta,
                planRevisionReason: revisionReason,
                message: `Plan revision ${proposedPlan.revision} resolves a ${designReview.repairScope.replaceAll("_", " ")} quality conflict. Approve it to resume the current worktree at the repaired slice boundary.`,
              });
              writeEvent(response, { type: "stream.completed", taskId });
              response.end();
              return;
            }

            const refinements = designRefinementCount(taskId);
            if (refinements >= maxDesignRefinements) {
              setExecutionState("BLOCKED");
              task = transitionTask(task, "BLOCKED", emit);
              appendTaskEvent(taskId, "DESIGN_REFINEMENT_LIMIT_REACHED", { refinements, maximum: maxDesignRefinements, review: designReview });
              emit({ type: "stream.blocked", message: `Visual Director still requires current-slice refinement after ${maxDesignRefinements} dedicated design passes. Changes remain isolated for inspection.` });
              response.end();
              return;
            }

            repairEvidence = `VISUAL DIRECTOR CURRENT-SLICE REFINEMENT REQUIRED. The Visual Director explicitly classified this repair as legal inside the current approved slice. Rework the design against the persisted Design Brief and screenshot evidence while preserving working behavior, then recapture responsive browser evidence.

Structured scope decision:
- repairScope: ${designReview.repairScope}
- scopeReason: ${designReview.scopeReason}

Work from the authoritative repair grounding that BORG injects automatically:
- Start from the supplied changed-file list, current source diff, changed-file contents, and direct dependencies. Do not guess paths, components, or CSS selectors.
- Read only further direct dependencies when necessary to repair an implicated file.
- Trace every style change to markup that actually uses it.
- Address the highest-severity visible findings with a material composition change, not small token or spacing adjustments.
- Do not broaden beyond the current slice; a wider change requires a new plan-revision classification.
- Capture mobile, tablet, and desktop evidence after editing and inspect whether the cited visual problem visibly changed before finishing.

${JSON.stringify(designReview).slice(0, 70000)}`;
            setExecutionState("REPAIR");
            task = scheduleDesignRefinement(task, emit, designReview.summary);
            continue;
          }

          if (designReview.status !== "pass") {
            finishRole(activeRoleAssignment, "completed", emit);
            activeRoleAssignment = null;
            setExecutionState("BLOCKED");
            task = transitionTask(task, "BLOCKED", emit);
            emit({ type: "design.review.blocked", designReview, message: designReview.summary });
            emit({ type: "stream.blocked", message: `Premium frontend delivery is blocked because mandatory aesthetic review is ${designReview.status}: ${designReview.summary}` });
            response.end();
            return;
          }
          emit({ type: "stage.updated", stage: "Visual Direction", status: "complete" });
        }

        let status = await tools.execute({ function: { name: "git_status", arguments: {} } }, "agent", taskContext, "verifier", activeDisciplines) as { stdout?: string };
        let diff = await tools.execute({ function: { name: "git_diff", arguments: {} } }, "agent", taskContext, "verifier", activeDisciplines) as { stdout?: string };
        finishRole(activeRoleAssignment, "completed", emit);
        recordHandoff({
          task,
          fromRole: "verifier",
          toRole: "reviewer",
          objective: task.request,
          changedFiles: (status.stdout ?? "").split("\n").filter(Boolean).slice(0, 200),
          evidence: [
            JSON.stringify(verification).slice(0, 20_000),
            ...(designReview ? [`Visual Director: ${designReview.status} — ${designReview.summary}`] : []),
          ],
          requiredNextAction: "Review the verified diff from fresh context without mutation access.",
        }, emit);
        activeRoleAssignment = null;
        emit({ type: "stage.updated", stage: "Verification", status: "complete" });
        setExecutionState("REVIEW");
        task = transitionTask(task, "REVIEWING", emit);
        if (sliceState && projectPlan) setFrontendWorkflowStage(approvedWorktreePath, "slice_reviewing", { currentSlice: sliceState.current, totalSlices: projectPlan.slices.length, taskId, detail: "Verification passed. Fresh review and visual quality gates are running." });
        emit({ type: "stage.updated", stage: "Review", status: "active" });
        const reviewerModel = teamPolicies.modelFor(teamPolicy, "reviewer", model, primaryDiscipline);
        activeRoleAssignment = beginRole(task, "reviewer", primaryDiscipline, reviewerModel, packs, emit);
        const activeSlice = sliceState && projectPlan ? projectPlan.slices[sliceState.current] ?? null : null;
        const styleAcceptance = styleWorkspace && projectPlan?.styles
          ? [
              projectPlan.styles.direction,
              ...projectPlan.styles.layoutPrinciples,
              ...projectPlan.styles.responsive,
              ...projectPlan.styles.accessibility,
              ...projectPlan.styles.avoid.map((item) => `Avoid: ${item}`),
            ]
          : [];
        const focusedAcceptance = focusedExecutionScope && projectPlan
          ? focusedExecutionScope.type === "page"
            ? projectPlan.sitemap.find((page) => page.id === focusedExecutionScope.id)?.acceptanceCriteria ?? []
            : projectPlan.components.find((component) => component.id === focusedExecutionScope.id)?.acceptanceCriteria ?? []
          : [];
        const review = await runFreshReview({
          ollamaUrl,
          model: reviewerModel,
          taskId,
          request: task.request,
          projectGoal: projectPlan?.siteGoal,
          sliceTitle: activeSlice?.title,
          sliceOutcome: activeSlice?.outcome,
          acceptanceCriteria: focusedAcceptance.length ? focusedAcceptance : styleAcceptance.length ? styleAcceptance : activeSlice?.acceptanceCriteria ?? projectPlan?.acceptanceCriteria ?? [],
          implementationBudgetExhausted,
          diff: diff.stdout ?? "",
          verification,
          specialistInstructions: specialistInstructions.reviewer,
          onRequestBody: websiteProject ? (body) => recordModelInput(taskId, "reviewer", reviewerModel, compiledFocus?.sliceId ?? compiledSlice?.sliceId ?? null, [], body) : undefined,
        });
        finishRole(activeRoleAssignment, "completed", emit);
        activeRoleAssignment = null;
        const reviewHistory = recordCompletedReview(
          task,
          [...(visionReview?.findings ?? []), ...review.findings],
          review.verdict,
          review.summary,
          task.attempts > 0
            ? [`Deterministic verification passed on repair attempt ${task.attempts}.`, `Fresh review run did not reproduce the prior finding.`]
            : [],
        );
        emit({ type: "review.history.updated" });
        const reviewedRepository = taskProjectRepository(taskId);
        if (reviewedRepository) for (const finding of review.findings) recordMemoryNote(reviewedRepository, {
          id: `finding:${finding.id}`, kind: "finding", text: `${finding.severity}: ${finding.title} — ${finding.description}`,
          taskId, path: finding.file && access.allowsRepositoryFile(finding.file) ? finding.file : null,
          line: finding.line ?? null, createdAt: new Date().toISOString(),
        });
        appendTaskEvent(taskId, "REVIEW_COMPLETED", { review, status, worktreePath: approval.worktreePath, model: reviewerModel, role: "reviewer", attempt: task.attempts });
        emit({ type: "review.completed", review });
        if (review.verdict === "repair") {
          recordHandoff({
            task,
            fromRole: "reviewer",
            toRole: "implementer",
            objective: task.request,
            evidence: review.findings.map((finding) => `${finding.severity}: ${finding.title} — ${finding.description}`).slice(0, 20),
            openRisks: [review.summary],
            requiredNextAction: "Repair only the blocking findings from independent review.",
          }, emit);
          emit({ type: "stage.updated", stage: "Review", status: "failed" });
          if (task.attempts >= maxRepairAttempts) {
            setExecutionState("BLOCKED");
            task = transitionTask(task, "BLOCKED", emit);
            appendTaskEvent(taskId, "REPAIR_LIMIT_REACHED", { attempts: task.attempts, review });
            emit({ type: "stream.blocked", message: `Fresh review still found a blocking issue after ${maxRepairAttempts} repair attempts.` });
            response.end();
            return;
          }
          repairEvidence = `Fresh-context review requires repair:\n${JSON.stringify(review).slice(0, 60_000)}`;
          setExecutionState("REPAIR");
          task = scheduleRepair(task, emit, "Fresh-context review found a blocking issue.");
          continue;
        }

        const unresolvedBlocking = blockingReviewFindings(reviewHistory.records);
        if (unresolvedBlocking.length) {
          emit({ type: "stage.updated", stage: "Review", status: "failed" });
          appendTaskEvent(taskId, "DELIVERY_BLOCKED_BY_REVIEW_HISTORY", {
            findingIds: unresolvedBlocking.map((record) => record.id),
          });
          emit({ type: "stream.blocked", message: `${unresolvedBlocking.length} unresolved high/critical review finding(s) block delivery. Resolve them in Review History.` });
          response.end();
          return;
        }

        if (focusedExecutionScope && projectPlan) {
          const changedPaths = (status.stdout ?? "").split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).trim()).filter((path) => path && !path.includes(" -> "));
          updateVerifiedProjectModel(approvedWorktreePath, changedPaths, focusedAcceptance);
          appendTaskEvent(taskId, "FOCUSED_WORKSPACE_VERIFIED", { scopeType: focusedExecutionScope.type, scopeId: focusedExecutionScope.id, changedPaths });
          status = await tools.execute({ function: { name: "git_status", arguments: {} } }, "agent", taskContext, "verifier", activeDisciplines) as { stdout?: string };
          diff = await tools.execute({ function: { name: "git_diff", arguments: {} } }, "agent", taskContext, "verifier", activeDisciplines) as { stdout?: string };
        }
        if (sliceState && projectPlan) {
          const summary = `Verified ${currentSlice(projectPlan, sliceState).title}.\n\nChanged files:\n${(status.stdout ?? "").slice(0, 1200)}\n\nVerification: passed.\n\nReview: ${review.summary.slice(0, 1200)}`;
          const changedPaths = (status.stdout ?? "").split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).trim()).filter((path) => path && !path.includes(" -> "));
          updateVerifiedProjectModel(approvedWorktreePath, changedPaths, currentSlice(projectPlan, sliceState).acceptanceCriteria);
          const ready = markSliceReady(approvedWorktreePath, taskId, summary, { plan: projectPlan, state: sliceState });
          if (ready) appendTaskEvent(taskId, "FRONTEND_SLICE_READY", { slice: ready.current, status: ready.status });
          status = await tools.execute({ function: { name: "git_status", arguments: {} } }, "agent", taskContext, "verifier", activeDisciplines) as { stdout?: string };
          diff = await tools.execute({ function: { name: "git_diff", arguments: {} } }, "agent", taskContext, "verifier", activeDisciplines) as { stdout?: string };
        }
        appendTaskEvent(taskId, "CHANGESET_CAPTURED", { status: status.stdout ?? "", diff: diff.stdout ?? "" });
        emit({ type: "implementation.summary", status, diff, worktreePath: approval.worktreePath });
        emit({ type: "stage.updated", stage: "Review", status: "complete" });
        setExecutionState("COMPLETE");
        task = transitionTask(task, "DELIVERY_READY", emit);
        appendTaskEvent(taskId, "DELIVERY_READY", { worktreePath: approval.worktreePath });
        emit({ type: "delivery.ready", worktreePath: approval.worktreePath, message: "Verified and independently reviewed. Choose how to deliver the isolated changes." });
        emit({ type: "stream.completed" });
        response.end();
        return;
      }
    })().catch(async (error) => {
      if (activeRoleAssignment?.status === "active") finishRole(activeRoleAssignment, "failed", emit);
      await Promise.allSettled([
        tools.execute({ function: { name: "browser_close", arguments: {} } }, "agent", taskContext),
      ]);
      const message = error instanceof Error ? error.message : "Approved implementation failed";
      if (tasks.listEvents(taskId).some((event) => event.type === "FRONTEND_SLICE_SELECTED") && websiteInfo(approvedWorktreePath) && readSliceState(approvedWorktreePath)) {
        const failedSlice = readSliceState(approvedWorktreePath)!;
        setFrontendWorkflowStage(approvedWorktreePath, "blocked", { currentSlice: failedSlice.current, totalSlices: failedSlice.total, taskId, detail: message });
      }
      appendTaskEvent(taskId, "IMPLEMENTATION_FAILED", { message });
      if (task && !["FAILED", "CANCELLED", "COMPLETE"].includes(task.state)) task = transitionTask(task, "FAILED", emit);
      emit({ type: "runtime.failed", message });
      response.end();
    });
    return;
  }
  const baselineRoute = request.url?.match(/^\/api\/tasks\/([^/]+)\/visual-baselines$/);
  if (request.method === "GET" && baselineRoute) {
    const taskId = decodeURIComponent(baselineRoute[1]);
    if (!tasks.findTask(taskId)) return send(response, 404, { error: "Task not found." });
    return send(response, 200, { candidates: pendingVisualBaselineCandidates(taskId) });
  }
  if (request.method === "POST" && baselineRoute) {
    const taskId = decodeURIComponent(baselineRoute[1]);
    void readJson(request).then((input) => {
      const task = tasks.findTask(taskId);
      const approval = tasks.findApproval(taskId);
      if (!task || !approval?.worktreePath || approval.status !== "APPROVED") return send(response, 404, { error: "Approved task worktree not found." });
      if (task.state !== "DELIVERY_READY") return send(response, 409, { error: "Visual baselines may be accepted only after verification and review complete." });
      if (!Array.isArray(input.candidates) || !input.candidates.length || input.candidates.length > 16) return send(response, 400, { error: "Provide between one and sixteen baseline candidates." });
      const worktreePath = approval.worktreePath;
      const accepted = input.candidates.map((value) => {
        const candidate = value as Record<string, unknown>;
        return visualRegression.acceptBaseline(worktreePath, {
          profileId: String(candidate.profileId ?? ""),
          screenshotName: String(candidate.screenshotName ?? ""),
          candidatePath: String(candidate.candidatePath ?? ""),
          candidateSha256: String(candidate.candidateSha256 ?? ""),
          width: Number(candidate.width),
          height: Number(candidate.height),
        } satisfies BaselineCandidate);
      });
      appendTaskEvent(taskId, "VISUAL_BASELINES_ACCEPTED", { accepted });
      return send(response, 200, { accepted });
    }).catch((error) => send(response, 400, { error: error instanceof Error ? error.message : "Unable to accept visual baselines" }));
    return;
  }

  const checkpointRoute = request.url?.match(/^\/api\/tasks\/([^/]+)\/checkpoints$/);
  if (checkpointRoute) {
    const taskId = decodeURIComponent(checkpointRoute[1]);
    const task = tasks.findTask(taskId);
    if (!task) return send(response, 404, { error: "Task not found" });
    if (request.method === "GET") {
      return send(response, 200, { checkpoints: tasks.listCheckpoints(taskId), continuations: tasks.listContinuations(taskId) });
    }
    if (request.method === "POST") {
      void readJson(request).then((input) => {
        const requestedMode = String(input.mode ?? recordedMode(taskId)) as PermissionMode;
        if (!["ask", "plan", "edit", "agent"].includes(requestedMode)) return send(response, 400, { error: "Invalid checkpoint mode." });
        const checkpoint = createCheckpointSnapshot(task, "manual", {
          name: typeof input.name === "string" ? input.name : undefined,
          sessionId: typeof input.sessionId === "string" ? input.sessionId : null,
          mode: requestedMode,
          contextSummary: typeof input.contextSummary === "string" ? input.contextSummary : undefined,
        });
        return send(response, 201, { checkpoint });
      }).catch((error) => send(response, 400, { error: error instanceof Error ? error.message : "Unable to create checkpoint" }));
      return;
    }
  }

  const reviewHistoryRoute = request.url?.match(/^\/api\/tasks\/([^/]+)\/review-history$/);
  if (reviewHistoryRoute) {
    const taskId = decodeURIComponent(reviewHistoryRoute[1]);
    const existingTask = tasks.findTask(taskId);
    if (!existingTask) return send(response, 404, { error: "Task not found" });
    if (request.method === "GET") {
      const findings = tasks.listReviewFindings(taskId);
      return send(response, 200, {
        runs: tasks.listReviewRuns(taskId), findings,
        occurrences: tasks.listReviewOccurrences(taskId), decisions: tasks.listReviewDecisions(taskId),
        blockingFindingIds: blockingReviewFindings(findings).map((value) => value.id),
      });
    }
    if (request.method === "POST") {
      void readJson(request).then((input) => {
        let resultingTask = existingTask;
        const finding = tasks.findReviewFinding(String(input.findingId ?? ""));
        if (!finding || finding.taskId !== taskId) return send(response, 404, { error: "Review finding not found" });
        const action = String(input.action ?? "") as ReviewDecision["action"];
        if (!["accept", "mark_fixed", "waive", "false_positive", "reopen", "supersede"].includes(action)) return send(response, 400, { error: "Invalid review decision." });
        const evidence = Array.isArray(input.evidence) ? input.evidence.map(String).filter(Boolean).slice(0, 50) : [];
        const latestRun = tasks.listReviewRuns(taskId).at(-1) ?? null;
        const decision: ReviewDecision = {
          id: randomUUID(), taskId, findingId: finding.id, runId: latestRun?.id ?? null,
          checkpointId: tasks.listCheckpoints(taskId).at(-1)?.id ?? null,
          continuationId: tasks.listContinuations(taskId).at(-1)?.id ?? null,
          action, resultingState: stateForDecision(action), reason: String(input.reason ?? "").trim().slice(0, 4000),
          evidence, actorType: "operator", actorId: "desktop-operator", createdAt: new Date().toISOString(),
        };
        const updated = applyReviewDecision(finding, decision);
        tasks.saveReviewHistory({ records: [updated], decisions: [decision] });
        appendTaskEvent(taskId, "REVIEW_DECISION_RECORDED", { decisionId: decision.id, findingId: finding.id, action, resultingState: updated.state });
        const blocking = blockingReviewFindings(tasks.listReviewFindings(taskId));
        if (blocking.length === 0 && resultingTask.state === "REVIEWING") resultingTask = transitionTask(resultingTask, "DELIVERY_READY");
        else if (blocking.length > 0 && resultingTask.state === "DELIVERY_READY") resultingTask = transitionTask(resultingTask, "REVIEWING");
        return send(response, 201, { task: resultingTask, finding: updated, decision, blockingFindingIds: blocking.map((value) => value.id) });
      }).catch((error) => send(response, 400, { error: error instanceof Error ? error.message : "Unable to record review decision" }));
      return;
    }
  }

  const continuationRoute = request.url?.match(/^\/api\/tasks\/([^/]+)\/continuations$/);
  if (continuationRoute) {
    const taskId = decodeURIComponent(continuationRoute[1]);
    const task = tasks.findTask(taskId);
    if (!task) return send(response, 404, { error: "Task not found" });
    if (request.method === "GET") return send(response, 200, { continuations: tasks.listContinuations(taskId) });
    if (request.method === "POST") {
      void readJson(request).then(async (input) => {
        const checkpoint = tasks.findCheckpoint(String(input.checkpointId ?? ""));
        if (!checkpoint || checkpoint.taskId !== taskId) return send(response, 404, { error: "Checkpoint not found" });
        const continuation = await continueFromCheckpoint(task, checkpoint, String(input.reason ?? "Resume from named checkpoint."));
        return send(response, continuation.status === "recovery_required" ? 409 : 200, { continuation, checkpoint });
      }).catch((error) => send(response, 400, { error: error instanceof Error ? error.message : "Unable to continue task" }));
      return;
    }
  }

  const approvalRoute = request.url?.match(/^\/api\/tasks\/([^/]+)\/approval$/);
  if (request.method === "GET" && approvalRoute) {
    const taskId = decodeURIComponent(approvalRoute[1]);
    const task = tasks.findTask(taskId);
    if (!task) return send(response, 404, { error: "Task not found" });
    const currentApproval = tasks.findApproval(taskId);
    const taskEvents = tasks.listEvents(taskId);
    const revisionEvent = taskEvents.findLast((event) => event.type === "PROJECT_PLAN_REVISION_PROPOSED");
    const pendingRevisionApproval = task.state === "AWAITING_APPROVAL" && currentApproval?.status === "REQUESTED" && Boolean(revisionEvent);
    return send(response, 200, {
      task,
      workflow: workflow.get(task.projectId)?.taskId === task.id ? workflow.get(task.projectId) : null,
      approval: currentApproval,
      projectPlanApproval: task.state === "AWAITING_APPROVAL" && currentApproval?.status === "REQUESTED" && taskEvents.some((event) => event.type === "PROJECT_PLAN_PROPOSED" || event.type === "PROJECT_PLAN_REVISION_PROPOSED"),
      projectPlanRevisionApproval: pendingRevisionApproval,
      planRevision: pendingRevisionApproval ? {
        delta: revisionEvent?.payload.delta ?? null,
        reason: String(revisionEvent?.payload.reason ?? ""),
        repairScope: String(revisionEvent?.payload.repairScope ?? ""),
      } : null,
      findings: tasks.listFindings(taskId),
      events: taskEvents,
      roleAssignments: tasks.listRoleAssignments(taskId),
      handoffs: tasks.listHandoffs(taskId),
    });
  }
  if (request.method === "POST" && approvalRoute) {
    const taskId = decodeURIComponent(approvalRoute[1]);
    void readJson(request).then(async (input) => {
      let task = tasks.findTask(taskId);
      const approval = tasks.findApproval(taskId);
      if (!task || !approval) return send(response, 404, { error: "Approval request not found" });
      const decision = String(input.decision ?? "").toLowerCase();
      if (approval.status !== "REQUESTED") {
        if ((decision === "approve" && approval.status === "APPROVED") || (decision === "reject" && approval.status === "REJECTED")) return send(response, 200, { task, approval });
        return send(response, 409, { error: `Approval was already ${approval.status.toLowerCase()}.` });
      }
      if (task.state !== "AWAITING_APPROVAL") return send(response, 409, { error: "Task is not awaiting approval." });
      const approvalEvents = tasks.listEvents(task.id);
      const isProjectPlanRevisionApproval = approvalEvents.some((event) => event.type === "PROJECT_PLAN_REVISION_PROPOSED");
      const isProjectPlanApproval = !isProjectPlanRevisionApproval && approvalEvents.some((event) => event.type === "PROJECT_PLAN_PROPOSED");
      const approvalKind = isProjectPlanRevisionApproval ? "project_plan_revision" as const : isProjectPlanApproval ? "project_plan" as const : "execution" as const;
      if (decision === "reject") {
        const rejected = { ...approval, status: "REJECTED" as const, decidedAt: new Date().toISOString() };
        const decided = workflow.decideApproval(task, rejected, approvalKind);
        task = decided.task;
        syncWorkflowProjection(task, decided.workflow);
        const repositoryPath = taskProjectRepository(task.id);
        if (repositoryPath) recordMemoryNote(repositoryPath, {
          id: `approval:${approval.id}`,
          kind: "decision",
          text: isProjectPlanRevisionApproval
            ? "Automatic project-plan revision was rejected; existing worktree remains isolated for inspection."
            : isProjectPlanApproval
              ? "Frontend phase plan requires revision."
              : "Implementation mini-plan rejected by operator.",
          taskId: task.id,
          path: null,
          line: null,
          createdAt: rejected.decidedAt!,
        });
        return send(response, 200, {
          task,
          approval: rejected,
          workflow: decided.workflow,
          projectPlanApproval: isProjectPlanApproval,
          projectPlanRevisionApproval: isProjectPlanRevisionApproval,
        });
      }
      if (decision !== "approve") return send(response, 400, { error: "Decision must be approve or reject." });
      const repositoryPath = taskProjectRepository(task.id);
      if (!repositoryPath) return send(response, 409, { error: "This task has no durable repository binding." });
      if (isProjectPlanRevisionApproval) {
        if (!approval.worktreePath || !approval.baseCommit || !existsSync(approval.worktreePath)) {
          return send(response, 409, { error: "Plan revision approval requires the existing approved worktree and base commit." });
        }
        const authoritativePlan = projectPlanFromWorkflow(workflow.get(task.projectId), approval.worktreePath);
        if (!authoritativePlan) return send(response, 409, { error: "The durable revised project plan is missing from SQLite." });
        const website = websiteInfo(approval.worktreePath);
        const revisionBrief = website?.originalBrief || task.request;
        const coverage = validateProjectPlanCoverage(authoritativePlan, revisionBrief);
        if (!coverage.valid) return send(response, 409, { error: "The revised project plan no longer passes semantic coverage.", coverage });

        const approved = { ...approval, status: "APPROVED" as const, decidedAt: new Date().toISOString() };
        const decided = workflow.decideApproval(task, approved, "project_plan_revision");
        task = decided.task;
        syncWorkflowProjection(task, decided.workflow);
        const approvedPlan = projectPlanFromWorkflow(decided.workflow, null);
        if (!approvedPlan) return send(response, 500, { error: "Core approved the plan revision without a durable plan snapshot." });
        const approvedProject = approveProjectPlan(approval.worktreePath, task.id, approvedPlan);
        setFrontendWorkflowStage(approval.worktreePath, "slice_implementing", {
          currentSlice: decided.workflow.sliceIndex ?? approvedProject.state.current,
          totalSlices: approvedPlan.slices.length,
          taskId: task.id,
          detail: `Plan revision ${approvedPlan.revision} approved. Resuming the existing worktree at the repaired slice boundary.`,
        });
        appendTaskEvent(task.id, "PROJECT_PLAN_REVISION_RESUMED", {
          revision: approvedPlan.revision,
          sliceIndex: decided.workflow.sliceIndex,
          worktreePath: approval.worktreePath,
          baseCommit: approval.baseCommit,
          coverage,
          workflowVersion: decided.workflow.version,
        });
        return send(response, 200, {
          task,
          approval: approved,
          workflow: decided.workflow,
          projectPlanApproved: false,
          projectPlanRevisionApproved: true,
          projectPlan: approvedProject.plan,
          slice: approvedProject.state,
          worktree: { path: approval.worktreePath, baseCommit: approval.baseCommit },
        });
      }
      if (isProjectPlanApproval) {
        const authoritativePlan = projectPlanFromWorkflow(workflow.get(task.projectId), repositoryPath);
        if (!authoritativePlan) return send(response, 409, { error: "The durable project plan is missing from SQLite." });
        const website = websiteInfo(repositoryPath);
        const planningBrief = website?.originalBrief || task.request;
        const coverage = validateProjectPlanCoverage(authoritativePlan, planningBrief);
        if (!coverage.valid) return send(response, 409, { error: "The project plan no longer passes semantic coverage and cannot be approved.", coverage });
        const approved = { ...approval, status: "APPROVED" as const, decidedAt: new Date().toISOString(), worktreePath: null, baseCommit: null };
        const decided = workflow.decideApproval(task, approved, "project_plan");
        task = decided.task;
        syncWorkflowProjection(task, decided.workflow);
        const approvedPlan = projectPlanFromWorkflow(decided.workflow, null);
        if (!approvedPlan) return send(response, 500, { error: "Core approved the project plan without a durable plan snapshot." });
        const approvedProject = approveProjectPlan(repositoryPath, task.id, approvedPlan);
        commitBuildDocs(repositoryPath, "Approve BORG frontend phase plan");
        return send(response, 200, { task, approval: approved, workflow: decided.workflow, projectPlanApproved: true, projectPlan: approvedProject.plan, slice: approvedProject.state });
      }
      const worktree = await worktrees.create(repositoryPath, task.id);
      const sliceIntent = tasks.listEvents(task.id).findLast((event) => event.type === "FRONTEND_SLICE_SELECTED")?.payload as { action?: SliceAction; feedback?: string } | undefined;
      const approved = { ...approval, status: "APPROVED" as const, decidedAt: new Date().toISOString(), worktreePath: worktree.path, baseCommit: worktree.baseCommit };
      const decided = workflow.decideApproval(task, approved, "execution");
      task = decided.task;
      syncWorkflowProjection(task, decided.workflow);
      let workflowState = decided.workflow;
      let preparedSlice: SliceState | null = null;
      if (sliceIntent) {
        workflowState = workflow.activateSlice(task);
        syncWorkflowProjection(task, workflowState);
        const website = websiteInfo(worktree.path);
        const approvedPlanText = tasks.listEvents(task.id).findLast((event) => event.type === "MODEL_RESPONSE_COMPLETED")?.payload.answer;
        if (website) {
          const authoritativePlan = projectPlanFromWorkflow(workflowState, null);
          const authoritativeSlice = sliceStateFromWorkflow(workflowState, authoritativePlan, null);
          if (!authoritativePlan || !authoritativeSlice) throw new Error("Core did not provide the selected frontend slice after execution approval.");
          preparedSlice = prepareSlice(
            worktree.path,
            website.originalBrief || task.request,
            sliceIntent.action ?? "initial",
            sliceIntent.feedback ?? "",
            task.id,
            typeof approvedPlanText === "string" ? approvedPlanText : "",
            { plan: authoritativePlan, state: authoritativeSlice },
          );
          setFrontendWorkflowStage(worktree.path, "slice_implementing", { currentSlice: preparedSlice.current, totalSlices: preparedSlice.total, taskId: task.id, detail: "Core selected the slice and implementation is starting inside its bounded mini-loop." });
        }
      }
      recordMemoryNote(repositoryPath, { id: `approval:${approval.id}`, kind: "decision", text: `Implementation plan approved at base commit ${worktree.baseCommit}.`, taskId: task.id, path: null, line: null, createdAt: approved.decidedAt! });
      createCheckpointSnapshot(task, "pre_edit", { mode: recordedMode(task.id) });
      return send(response, 200, { task, approval: approved, workflow: workflowState, worktree: worktrees.describe(worktree) });
    }).catch((error) => send(response, 400, { error: error instanceof Error ? error.message : "Unable to decide approval" }));
    return;
  }
  if (request.method === "GET" && request.url?.startsWith("/api/tasks")) {
    const projectId = new URL(request.url, `http://localhost:${port}`).searchParams.get("projectId") ?? "local";
    return send(response, 200, { tasks: tasks.listTasks(projectId), workflow: workflow.get(projectId) });
  }
  if (request.method === "GET" && request.url === "/api/access") return send(response, 200, { access: access.describe() });
  if (request.method === "POST" && request.url === "/api/access") {
    void readJson(request).then((input) => send(response, 200, { access: access.describe(access.save(input)) }))
      .catch((error) => send(response, 400, { error: error instanceof Error ? error.message : "Invalid access policy" }));
    return;
  }
  if (request.method === "GET" && request.url === "/api/vision") {
    void visionRuntimeStatus().then((status) => send(response, 200, { vision: status }))
      .catch((error) => send(response, 500, { error: error instanceof Error ? error.message : "Unable to inspect visual quality model." }));
    return;
  }
  if (request.method === "POST" && request.url === "/api/vision") {
    void readJson(request).then(async (input) => {
      vision.save(input);
      return send(response, 200, { vision: await visionRuntimeStatus() });
    }).catch((error) => send(response, 400, { error: error instanceof Error ? error.message : "Invalid vision settings" }));
    return;
  }
  if (request.method === "GET" && request.url === "/api/language-intelligence") {
    try {
      return send(response, 200, { providers: tools.languageStatus() });
    } catch (error) {
      return send(response, 409, { error: error instanceof Error ? error.message : "Language intelligence is unavailable" });
    }
  }
  if (request.method === "GET" && request.url === "/api/tools") return send(response, 200, { tools: tools.status() });
  if (request.method === "POST" && request.url === "/api/tools") {
    void readJson(request).then((input) => send(response, 200, { tools: tools.configure(input) }))
      .catch((error) => send(response, 400, { error: error instanceof Error ? error.message : "Invalid tool settings" }));
    return;
  }
  if (request.method === "POST" && request.url === "/api/chat") {
    const planningAbort = new AbortController();
    request.once("aborted", () => planningAbort.abort());
    response.once("close", () => { if (!response.writableEnded) planningAbort.abort(); });
    response.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "access-control-allow-origin": "http://localhost:5173",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    void readJson(request).then(async (input) => {
      const requestedMode = String(input.mode ?? "ask").toLowerCase();
      const mode: PermissionMode = (["ask", "plan", "edit", "agent"] as const).includes(requestedMode as PermissionMode)
        ? requestedMode as PermissionMode
        : "ask";
      const requestText = String(input.request ?? "");
      const projectId = String(input.projectId ?? "local");
      const authorityProjectId = typeof input.authorityProjectId === "string" && input.authorityProjectId.trim()
        ? input.authorityProjectId.trim()
        : projectId;
      await planningOrchestrator.run({
        mode,
        request: requestText,
        projectId,
        authorityProjectId,
        sliceAction: String(input.sliceAction ?? "initial"),
        scopeId: input.scopeId == null ? null : String(input.scopeId),
        workflowCommandId: typeof input.workflowCommandId === "string" ? input.workflowCommandId : null,
      }, (event) => writeEvent(response, event), planningAbort.signal);
      response.end();
    }).catch((error) => {
      console.error("[chat] request failed", error);
      writeEvent(response, { type: "stream.failed", message: error instanceof Error ? error.message : "Invalid request" });
      response.end();
    });
    return;
  }
  if (request.method === "POST" && request.url === "/api/tasks") {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      try {
        const input = JSON.parse(body) as { projectId?: string; request?: string };
        const task = createTask({ id: randomUUID(), projectId: input.projectId ?? "local", request: input.request ?? "" });
        tasks.saveTask(task);
        tasks.appendEvent({ id: randomUUID(), taskId: task.id, type: "TASK_CREATED", payload: {}, occurredAt: task.createdAt });
        send(response, 201, { task });
      } catch (error) { send(response, 400, { error: error instanceof Error ? error.message : "Invalid request" }); }
    });
    return;
  }
  send(response, 404, { error: "Not found" });
});

void recoverInterruptedTasks()
  .catch((error) => console.error("[workflow] startup recovery failed", error))
  .finally(() => server.listen(port, "127.0.0.1", () => console.log(`BORG server listening on http://127.0.0.1:${port}`)));

async function shutdown(signal: string) {
  console.log(`[lifecycle] core shutdown requested: ${signal}`);
  await processRuntime.stopAll();
  tasks.close();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  process.exit(0);
}

process.once("SIGINT", () => { void shutdown("SIGINT"); });
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
