import { z } from "zod";
import {
  ApprovalSchema,
  TaskCheckpointSchema,
  TaskContinuationSchema,
  TaskSchema,
  WorkflowStateSchema,
  type Approval,
  type Task,
  type WorkflowState,
} from "./contracts.ts";
import { WorkflowEventSchema } from "./workflow-events.ts";

export const debugDiagnosticSeverities = ["info", "warning", "error"] as const;

export const DebugDiagnosticSchema = z.object({
  id: z.string().min(1),
  severity: z.enum(debugDiagnosticSeverities),
  title: z.string().min(1),
  detail: z.string().min(1),
  scope: z.enum(["workflow", "verification", "recovery", "approval", "context", "runtime", "repository"]),
  suggestedAction: z.string().min(1),
});
export type DebugDiagnostic = z.infer<typeof DebugDiagnosticSchema>;

export const DebugProcessSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  label: z.string().min(1),
  command: z.string(),
  args: z.array(z.string()),
  cwd: z.string(),
  url: z.string().nullable(),
  pid: z.number().int().nullable(),
  status: z.string().min(1),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  durationMs: z.number().nonnegative().nullable(),
  stdout: z.string(),
  stderr: z.string(),
});
export type DebugProcess = z.infer<typeof DebugProcessSchema>;

export const DebugContextPackSummarySchema = z.object({
  id: z.string().min(1),
  profileId: z.string().min(1),
  kind: z.string().min(1),
  stage: z.string().min(1),
  workflowVersion: z.number().int().positive().nullable(),
  sliceId: z.string().nullable(),
  authority: z.string().min(1),
  fingerprint: z.string().min(1),
  characters: z.number().int().nonnegative(),
  budgetCharacters: z.number().int().positive(),
  manifestCount: z.number().int().nonnegative(),
  manifest: z.array(z.object({
    kind: z.string().min(1),
    path: z.string().min(1),
    reason: z.string().min(1),
    characters: z.number().int().nonnegative(),
    required: z.boolean(),
  })),
  createdAt: z.string().datetime(),
});
export type DebugContextPackSummary = z.infer<typeof DebugContextPackSummarySchema>;

export const DebugModelContextSummarySchema = z.object({
  id: z.string().min(1),
  role: z.string().min(1),
  model: z.string().min(1),
  sliceId: z.string().nullable(),
  inputSha256: z.string().min(1),
  manifestCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
});
export type DebugModelContextSummary = z.infer<typeof DebugModelContextSummarySchema>;

export const DebugGitStateSchema = z.object({
  repositoryPath: z.string().nullable(),
  worktreePath: z.string().nullable(),
  baseCommit: z.string().nullable(),
  headCommit: z.string().nullable(),
  status: z.string(),
  worktreeExists: z.boolean().nullable(),
});
export type DebugGitState = z.infer<typeof DebugGitStateSchema>;

export const DebugSnapshotSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string().datetime(),
  readOnly: z.literal(true),
  task: TaskSchema,
  workflow: WorkflowStateSchema.nullable(),
  approval: ApprovalSchema.nullable(),
  status: z.record(z.string(), z.unknown()),
  events: z.array(WorkflowEventSchema),
  contextPacks: z.array(DebugContextPackSummarySchema),
  modelContexts: z.array(DebugModelContextSummarySchema),
  processes: z.array(DebugProcessSchema),
  git: DebugGitStateSchema,
  checkpoints: z.array(TaskCheckpointSchema),
  continuations: z.array(TaskContinuationSchema),
  roleAssignments: z.array(z.unknown()),
  handoffs: z.array(z.unknown()),
  reviewRuns: z.array(z.unknown()),
  reviewFindings: z.array(z.unknown()),
  diagnostics: z.array(DebugDiagnosticSchema),
  redaction: z.object({
    version: z.literal(1),
    sensitiveFieldsRedacted: z.boolean(),
    rawModelInputIncluded: z.literal(false),
    environmentValuesIncluded: z.literal(false),
  }),
});
export type DebugSnapshot = z.infer<typeof DebugSnapshotSchema>;

export interface DebugInvariantInput {
  task: Task;
  workflow: WorkflowState | null;
  approval: Approval | null;
  latestContextWorkflowVersion: number | null;
  latestContextKind: string | null;
  latestContextManifestCount: number | null;
  latestContextCharacters: number | null;
  latestContextBudgetCharacters: number | null;
  worktreeExists: boolean | null;
  baseCommitAncestorOfHead: boolean | null;
  activeRoleCount: number;
  activeProcessCount: number;
  failedProcessCount: number;
  latestEventAt: string | null;
  nowMs?: number;
}

function finding(
  id: string,
  severity: DebugDiagnostic["severity"],
  scope: DebugDiagnostic["scope"],
  title: string,
  detail: string,
  suggestedAction: string,
): DebugDiagnostic {
  return DebugDiagnosticSchema.parse({ id, severity, scope, title, detail, suggestedAction });
}

export function evaluateDebugInvariants(input: DebugInvariantInput): DebugDiagnostic[] {
  const { task, workflow, approval } = input;
  const diagnostics: DebugDiagnostic[] = [];

  if (!workflow) {
    diagnostics.push(finding(
      "workflow.missing",
      "warning",
      "workflow",
      "No durable workflow row",
      "This task has no WorkflowEngine state. It may be a legacy or non-workflow task.",
      "Inspect task events before assuming project progression can continue automatically.",
    ));
    return diagnostics;
  }

  if (workflow.taskId !== task.id) {
    diagnostics.push(finding(
      "workflow.owner_mismatch",
      "error",
      "workflow",
      "Workflow owner does not match task",
      `Workflow is owned by ${workflow.taskId ?? "no task"}, while this snapshot is for ${task.id}.`,
      "Do not advance this task until workflow ownership is reconciled.",
    ));
  }

  if (task.state === "RECOVERY_REQUIRED" && workflow.recovery.status === "inactive") {
    diagnostics.push(finding(
      "recovery.descriptor_missing",
      "error",
      "recovery",
      "Recovery details are missing",
      "The task requires recovery, but the durable workflow has no active recovery descriptor.",
      "Inspect the interrupted checkpoint and restore an explicit safe resume action.",
    ));
  }

  if (task.state === "AWAITING_APPROVAL" && approval?.status !== "REQUESTED") {
    diagnostics.push(finding(
      "approval.request_missing",
      "error",
      "approval",
      "Approval state is inconsistent",
      `Task is awaiting approval, but the persisted approval is ${approval?.status ?? "missing"}.`,
      "Reconcile the approval record before allowing mutation.",
    ));
  }

  const postVerification = ["REVIEWING", "DELIVERY_READY", "DELIVERING"].includes(task.state);
  if (postVerification && workflow.verification.status !== "passed") {
    diagnostics.push(finding(
      "verification.required_gate_missing",
      "error",
      "verification",
      "Post-verification state lacks a passed gate",
      `Task is ${task.state}, but durable verification is ${workflow.verification.status}.`,
      "Block delivery and inspect the verification transition that advanced the task.",
    ));
  }

  if (workflow.verification.status !== "pending" && workflow.verification.attempt !== task.attempts) {
    diagnostics.push(finding(
      "verification.attempt_mismatch",
      "error",
      "verification",
      "Verification belongs to another repair attempt",
      `Verification is for attempt ${workflow.verification.attempt}, while the task is on attempt ${task.attempts}.`,
      "Invalidate the stale verification result and verify the current attempt.",
    ));
  }

  if (approval?.status === "APPROVED" && approval.worktreePath && input.worktreeExists === false) {
    diagnostics.push(finding(
      "repository.approved_worktree_missing",
      "error",
      "repository",
      "Approved worktree is missing",
      "The approval authorizes a worktree path that no longer exists.",
      "Require recovery instead of recreating or mutating a different worktree implicitly.",
    ));
  }

  if (approval?.status === "APPROVED" && approval.baseCommit && input.baseCommitAncestorOfHead === false) {
    diagnostics.push(finding(
      "repository.base_not_ancestor",
      "error",
      "repository",
      "Approved base commit is not an ancestor of worktree HEAD",
      "The current worktree history no longer descends from the commit that was approved for mutation.",
      "Stop automatic delivery and inspect worktree divergence before continuing.",
    ));
  }

  if (workflow.pendingCommand?.claimedByTaskId && workflow.pendingCommand.claimedByTaskId !== workflow.taskId) {
    diagnostics.push(finding(
      "workflow.command_claim_mismatch",
      "error",
      "workflow",
      "Pending command is claimed by another task",
      `Pending command is claimed by ${workflow.pendingCommand.claimedByTaskId}, but workflow ownership is ${workflow.taskId ?? "unassigned"}.`,
      "Release or reconcile the command claim before launching another slice.",
    ));
  }

  if (workflow.pendingCommand && !workflow.pendingCommand.claimedByTaskId) {
    const ageMs = (input.nowMs ?? Date.now()) - new Date(workflow.pendingCommand.createdAt).getTime();
    if (ageMs >= 30_000) {
      diagnostics.push(finding(
        "workflow.command_unclaimed",
        "warning",
        "workflow",
        "Workflow command has not been claimed",
        `${workflow.pendingCommand.action} has remained unclaimed for ${Math.floor(ageMs / 1000)} seconds (command ${workflow.pendingCommand.id}).`,
        "Inspect the desktop workflow driver and confirm it is polling/consuming the durable pending command.",
      ));
    }
  }

  if (
    input.latestContextWorkflowVersion !== null
    && input.latestContextWorkflowVersion > workflow.version
  ) {
    diagnostics.push(finding(
      "context.future_workflow_version",
      "error",
      "context",
      "ContextPack references a future workflow version",
      `Latest ContextPack references workflow v${input.latestContextWorkflowVersion}, but durable workflow is v${workflow.version}.`,
      "Inspect persistence ordering before using that ContextPack.",
    ));
  }

  if (
    input.latestContextWorkflowVersion !== null
    && workflow.version - input.latestContextWorkflowVersion >= 3
    && ["IMPLEMENTING", "VERIFYING", "REVIEWING"].includes(task.state)
  ) {
    diagnostics.push(finding(
      "context.stale_workflow_version",
      "warning",
      "context",
      "ContextPack may be stale",
      `Latest ContextPack was compiled for workflow v${input.latestContextWorkflowVersion}, while the durable workflow is v${workflow.version}.`,
      "Confirm the active scope still matches the persisted ContextPack before another model call.",
    ));
  }

  if (
    input.latestContextKind
    && ["slice", "page", "component", "styles"].includes(input.latestContextKind)
    && (input.latestContextManifestCount ?? 0) > 30
  ) {
    diagnostics.push(finding(
      "context.scope_too_broad",
      "warning",
      "context",
      "Scoped ContextPack is unusually broad",
      `${input.latestContextKind} context contains ${input.latestContextManifestCount} manifest items.`,
      "Inspect the manifest for unrelated files before allowing future scoped model calls.",
    ));
  }

  if (
    input.latestContextCharacters !== null
    && input.latestContextBudgetCharacters !== null
    && input.latestContextBudgetCharacters > 0
    && input.latestContextCharacters / input.latestContextBudgetCharacters >= 0.95
  ) {
    diagnostics.push(finding(
      "context.near_budget_limit",
      "warning",
      "context",
      "ContextPack is near its character budget",
      `Latest ContextPack uses ${input.latestContextCharacters} of ${input.latestContextBudgetCharacters} characters.`,
      "Inspect lower-priority context sources before the next compile grows beyond the bounded profile.",
    ));
  }

  if (input.activeRoleCount > 1) {
    diagnostics.push(finding(
      "runtime.multiple_active_roles",
      "warning",
      "runtime",
      "Multiple engineering roles are active",
      `${input.activeRoleCount} role assignments are simultaneously marked active for one task.`,
      "Inspect role handoff completion and close stale active assignments.",
    ));
  }

  const progressStates = ["IMPLEMENTING", "VERIFYING", "REVIEWING", "DELIVERING"];
  if (progressStates.includes(task.state) && input.activeProcessCount === 0 && input.latestEventAt) {
    const idleMs = (input.nowMs ?? Date.now()) - new Date(input.latestEventAt).getTime();
    if (idleMs >= 300_000) {
      diagnostics.push(finding(
        "runtime.no_progress",
        "warning",
        "runtime",
        "Workflow may be stalled",
        `Task has remained ${task.state} without a managed process or persisted activity for ${Math.floor(idleMs / 60_000)} minutes.`,
        "Inspect the latest model/tool event and workflow command before retrying or mutating state.",
      ));
    }
  }

  if (input.failedProcessCount > 0 && ["VERIFYING", "REVIEWING", "DELIVERING"].includes(task.state)) {
    diagnostics.push(finding(
      "runtime.failed_process_during_gate",
      "warning",
      "runtime",
      "A managed process failed during a quality gate",
      `${input.failedProcessCount} managed process(es) have failed while the task is ${task.state}.`,
      "Inspect process stderr and verification evidence before continuing.",
    ));
  }

  if (!diagnostics.length) {
    diagnostics.push(finding(
      "control_plane.consistent",
      "info",
      "workflow",
      "No control-plane invariant violations detected",
      "Durable workflow, approval, verification, recovery, and runtime evidence are internally consistent.",
      "Continue observing the active workflow.",
    ));
  }

  return diagnostics;
}

const sensitiveKey = /(authorization|cookie|credential|password|passwd|secret|token|api[_-]?key|private[_-]?key)/i;
const secretPatterns: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]"],
  [/\b(?:sk|sk-proj|ghp|github_pat)_[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_TOKEN]"],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]"],
  [/([?&](?:token|key|secret|password|api_key)=)[^&#\s]+/gi, "$1[REDACTED]"],
];

function redactString(value: string): string {
  let next = value;
  for (const [pattern, replacement] of secretPatterns) next = next.replace(pattern, replacement);
  return next;
}

export function redactDebugValue(value: unknown, keyHint = ""): unknown {
  if (sensitiveKey.test(keyHint)) return "[REDACTED]";
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redactDebugValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => [key, redactDebugValue(item, key)]),
    );
  }
  return value;
}
