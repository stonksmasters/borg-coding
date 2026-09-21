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
import { OllamaVisionProvider, VisionReviewService } from "../../../packages/vision-review/src/index.ts";
import { VisualRegressionService, type BaselineCandidate, type VisualRegressionReport } from "../../../packages/visual-regression/src/index.ts";
import {
  DisciplineRouter,
  TeamPolicyService,
  roleCapabilities,
  specialistPackRefs,
  type SpecialistCapabilityPack,
} from "../../../packages/orchestration/src/index.ts";
import { deriveWorkflowStatus } from "./workflow-status.ts";
import { runOllamaAgent } from "./ollama-agent.ts";
import { PlanningOrchestrator } from "./planning-orchestrator.ts";
import { ExecutionOrchestrator } from "./execution-orchestrator.ts";
import { VerificationService } from "./verification-service.ts";
import { QualityGateService } from "./quality-gate-service.ts";
import { ProjectPlanRevisionService } from "./project-plan-revision-service.ts";
import { runFreshReview } from "./fresh-review.ts";
import { buildChangeLog } from "./change-log.ts";
import { ProcessRuntime, findAvailableLoopbackPort, type ProcessRuntimeEvent } from "../../../packages/process-runtime/src/index.ts";
import { websiteInfo } from "../../../packages/web-builder/src/project-bootstrap.ts";
import { projectWorkflowState } from "../../../packages/web-builder/src/workflow-projection.ts";
import { ensurePreviewDependencies } from "../../../packages/web-builder/src/preview-dependencies.ts";
import { type CompiledContext, type ContextItem } from "../../../packages/web-builder/src/context-compiler.ts";
import { approveProjectPlan, currentSlice, prepareSlice, projectDeliveredFrontendCheckpoint, readPersistedDesignBrief, readProjectDocs, readProjectPlan, readSliceState, setFrontendWorkflowStage, validateProjectPlanCoverage, type ProjectPlan, type SliceAction, type SliceState } from "../../../packages/web-builder/src/slice-docs.ts";
import {
  DesignBriefSchema,
  DesignDirectorService,
  VisualDirectorService,
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

const verificationService = new VerificationService({ tools, processRuntime });
const qualityGateService = new QualityGateService({
  vision,
  visualDirector,
  ollamaUrl,
  runReview: runFreshReview,
});
const projectPlanRevisionService = new ProjectPlanRevisionService({
  ollamaUrl,
  runAgent: runOllamaAgent,
});

const executionOrchestrator = new ExecutionOrchestrator({
  tasks,
  workflow,
  tools,
  teamPolicies,
  access,
  verificationService,
  qualityGateService,
  projectPlanRevisionService,
  ollamaUrl,
  model,
  maxRepairAttempts,
  maxDesignRefinements,
  appendTaskEvent,
  syncWorkflowProjection,
  taskProjectRepository,
  latestDesignBrief,
  taskWorkflowAuthorityProjectId,
  projectPlanFromWorkflow,
  sliceStateFromWorkflow,
  recordModelInput,
  recordContextPack,
  beginRole,
  finishRole,
  recordHandoff,
  createCheckpointSnapshot,
  recordCompletedReview,
  recordMemoryNote,
  contextSourceHints,
});

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
    attemptPhase: durableWorkflow?.attemptPhase ?? null,
    designRefinementAttempt: durableWorkflow?.designRefinementAttempt ?? 0,
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
    attemptPhase: checkpoint.attemptPhase,
    designRefinementAttempt: checkpoint.designRefinementAttempt,
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
    const task = tasks.findTask(taskId);
    const approval = tasks.findApproval(taskId);
    if (!task || !approval) return send(response, 404, { error: "Approved task not found" });
    if (task.state !== "IMPLEMENTING" || approval.status !== "APPROVED" || !approval.worktreePath || !approval.baseCommit) {
      return send(response, 409, { error: "Task is not ready for approved implementation." });
    }
    response.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "access-control-allow-origin": "http://localhost:5173",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    void executionOrchestrator.run(task, approval, (event) => writeEvent(response, event))
      .then(() => response.end())
      .catch((error) => {
        writeEvent(response, { type: "runtime.failed", taskId, message: error instanceof Error ? error.message : "Approved implementation failed" });
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
