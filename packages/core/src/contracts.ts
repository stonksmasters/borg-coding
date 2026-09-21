import { z } from "zod";
import { permissionModes } from "./chat-session.ts";
import {
  ProjectComponentSchema,
  ProjectPageSchema,
  ProjectPlanSchema,
  ProjectSliceSchema,
  ProjectStyleSystemSchema,
  projectPhases,
  type ProjectComponent,
  type ProjectPage,
  type ProjectPlan,
  type ProjectSlice,
  type ProjectStyleSystem,
} from "./project-domain.ts";

export const taskStates = ["CREATED", "CLASSIFYING", "DISCOVERING", "PLANNING", "AWAITING_APPROVAL", "IMPLEMENTING", "VERIFYING", "REVIEWING", "DELIVERY_READY", "DELIVERING", "PAUSED", "RECOVERY_REQUIRED", "COMPLETE", "BLOCKED", "FAILED", "CANCELLED"] as const;
export const riskLevels = ["R0", "R1", "R2", "R3", "R4"] as const;
export const severityLevels = ["info", "low", "medium", "high", "critical"] as const;
export const approvalStatuses = ["REQUESTED", "APPROVED", "REJECTED"] as const;
export const engineeringRoles = ["architect", "implementer", "verifier", "reviewer"] as const;
export const engineeringDisciplines = ["general", "frontend", "backend", "database", "security", "qa", "devops", "infrastructure"] as const;
export const roleAssignmentStatuses = ["pending", "active", "completed", "failed"] as const;
export const checkpointKinds = ["manual", "plan_complete", "pre_edit", "implementation_complete", "verification_complete", "pre_repair", "pre_delivery", "interrupted"] as const;
export const continuationStatuses = ["ready", "recovery_required", "completed", "failed"] as const;
export const repositoryRecoveryStates = ["matched", "dirty", "diverged", "missing", "not_applicable"] as const;
export const continuationActions = ["await_approval", "replan", "inspect_worktree", "deliver", "none"] as const;
export const reviewFindingStates = ["open", "accepted", "fixed", "waived", "false_positive", "reopened", "superseded"] as const;
export const reviewDecisionActions = ["accept", "mark_fixed", "waive", "false_positive", "reopen", "supersede"] as const;
export const reviewDecisionActors = ["operator", "reviewer", "system"] as const;
export const reviewRunStatuses = ["running", "completed", "failed"] as const;
export const workflowPhases = projectPhases;
export const workflowLoops = ["project", "slice", "backend", "general"] as const;
export const workflowStatuses = ["idle", "planning", "awaiting_approval", "running", "verifying", "reviewing", "awaiting_feedback", "recovery_required", "complete", "blocked", "failed", "cancelled"] as const;
export const workflowActions = ["plan", "await_approval", "start_slice", "implement", "verify", "repair", "quality_review", "review", "checkpoint", "advance_slice", "request_feedback", "plan_backend", "deliver", "recover", "none"] as const;
export const verificationStatuses = ["pending", "passed", "failed"] as const;
export const recoveryStatuses = ["inactive", "required", "repairing", "blocked"] as const;
export const recoveryResumeActions = ["inspect_worktree", "retry_current_scope", "await_approval", "deliver", "replan", "none"] as const;
export const attemptPhases = ["implementation", "technical_repair", "design_refinement"] as const;

export const VerificationGateSchema = z.object({
  status: z.enum(verificationStatuses),
  attempt: z.number().int().nonnegative(),
  profile: z.string().min(1).nullable(),
  summary: z.string(),
  browserPassed: z.boolean().nullable(),
  specialistPassed: z.boolean().nullable(),
  resultSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  completedAt: z.string().datetime().nullable(),
});
export type VerificationGate = z.infer<typeof VerificationGateSchema>;

export const inactiveVerificationGate: VerificationGate = {
  status: "pending",
  attempt: 0,
  profile: null,
  summary: "",
  browserPassed: null,
  specialistPassed: null,
  resultSha256: null,
  completedAt: null,
};

export const WorkflowRecoverySchema = z.object({
  status: z.enum(recoveryStatuses),
  category: z.string().min(1).nullable(),
  previousTaskState: z.enum(taskStates).nullable(),
  checkpointId: z.string().min(1).nullable(),
  resumeAction: z.enum(recoveryResumeActions),
  reason: z.string(),
  updatedAt: z.string().datetime().nullable(),
});
export type WorkflowRecovery = z.infer<typeof WorkflowRecoverySchema>;

export const inactiveWorkflowRecovery: WorkflowRecovery = {
  status: "inactive",
  category: null,
  previousTaskState: null,
  checkpointId: null,
  resumeAction: "none",
  reason: "",
  updatedAt: null,
};

export const WorkflowProjectSliceSchema = ProjectSliceSchema;
export type WorkflowProjectSlice = ProjectSlice;

export const WorkflowSitemapPageSchema = ProjectPageSchema;
export type WorkflowSitemapPage = ProjectPage;

export const WorkflowPlannedComponentSchema = ProjectComponentSchema;
export type WorkflowPlannedComponent = ProjectComponent;

export const WorkflowStyleSystemSchema = ProjectStyleSystemSchema;
export type WorkflowStyleSystem = ProjectStyleSystem;

export const WorkflowProjectPlanSchema = ProjectPlanSchema;
export type WorkflowProjectPlan = ProjectPlan;

export const WorkflowCommandSchema = z.object({
  id: z.string().min(1),
  action: z.enum(workflowActions),
  workflowVersion: z.number().int().positive(),
  createdAt: z.string().datetime(),
  targetSliceIndex: z.number().int().nonnegative().nullable().default(null),
  claimedByTaskId: z.string().min(1).nullable().default(null),
  claimedAt: z.string().datetime().nullable().default(null),
});
export type WorkflowCommand = z.infer<typeof WorkflowCommandSchema>;

export const TaskSchema = z.object({
  id: z.string().min(1), projectId: z.string().min(1), request: z.string().min(1),
  state: z.enum(taskStates), riskLevel: z.enum(riskLevels),
  disciplines: z.array(z.string()), languages: z.array(z.string()), frameworks: z.array(z.string()), platforms: z.array(z.string()),
  attempts: z.number().int().nonnegative(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
});
export type Task = z.infer<typeof TaskSchema>;
export type TaskState = Task["state"];
export type RiskLevel = Task["riskLevel"];

export const ApprovalSchema = z.object({
  id: z.string().min(1), taskId: z.string().min(1), status: z.enum(approvalStatuses),
  requestedAt: z.string().datetime(), decidedAt: z.string().datetime().nullable(),
  worktreePath: z.string().nullable(), baseCommit: z.string().nullable(),
});
export type Approval = z.infer<typeof ApprovalSchema>;

export const FindingSchema = z.object({
  id: z.string().min(1), taskId: z.string().min(1), discipline: z.string().min(1), severity: z.enum(severityLevels),
  category: z.string().min(1), title: z.string().min(1), description: z.string().min(1),
  file: z.string().optional(), line: z.number().int().positive().optional(), evidence: z.string().optional(), remediation: z.string().optional(),
  screenshot: z.string().optional(), screenshotSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
  confidence: z.number().min(0).max(1).optional(), selector: z.string().optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const ReviewRunSchema = z.object({
  id: z.string().min(1), taskId: z.string().min(1), checkpointId: z.string().min(1).nullable(),
  continuationId: z.string().min(1).nullable(), attempt: z.number().int().nonnegative(),
  status: z.enum(reviewRunStatuses), verdict: z.enum(["pass", "repair", "unknown"]), summary: z.string(),
  startedAt: z.string().datetime(), completedAt: z.string().datetime().nullable(),
});
export type ReviewRun = z.infer<typeof ReviewRunSchema>;

export const ReviewFindingRecordSchema = z.object({
  id: z.string().min(1), taskId: z.string().min(1), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  firstSeenRunId: z.string().min(1), lastSeenRunId: z.string().min(1), state: z.enum(reviewFindingStates),
  finding: FindingSchema, firstSeenAt: z.string().datetime(), lastSeenAt: z.string().datetime(),
});
export type ReviewFindingRecord = z.infer<typeof ReviewFindingRecordSchema>;

export const ReviewFindingOccurrenceSchema = z.object({
  id: z.string().min(1), taskId: z.string().min(1), runId: z.string().min(1), findingId: z.string().min(1),
  finding: FindingSchema, observedAt: z.string().datetime(),
});
export type ReviewFindingOccurrence = z.infer<typeof ReviewFindingOccurrenceSchema>;

export const ReviewDecisionSchema = z.object({
  id: z.string().min(1), taskId: z.string().min(1), findingId: z.string().min(1),
  runId: z.string().min(1).nullable(), checkpointId: z.string().min(1).nullable(), continuationId: z.string().min(1).nullable(),
  action: z.enum(reviewDecisionActions), resultingState: z.enum(reviewFindingStates),
  reason: z.string().max(4000), evidence: z.array(z.string().min(1)).max(50),
  actorType: z.enum(reviewDecisionActors), actorId: z.string().min(1), createdAt: z.string().datetime(),
});
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;

export const TaskEventSchema = z.object({ id: z.string().min(1), taskId: z.string().min(1), type: z.string().min(1), payload: z.record(z.string(), z.unknown()), occurredAt: z.string().datetime() });
export type TaskEvent = z.infer<typeof TaskEventSchema>;

export const WorkflowStateSchema = z.object({
  projectId: z.string().min(1), taskId: z.string().min(1).nullable(),
  loop: z.enum(workflowLoops).default("general"),
  phase: z.enum(workflowPhases), status: z.enum(workflowStatuses), nextAction: z.enum(workflowActions),
  planApprovalId: z.string().min(1).nullable(), planApproved: z.boolean(),
  projectPlan: WorkflowProjectPlanSchema.nullable().default(null),
  planRevisionResumeIndex: z.number().int().nonnegative().nullable().default(null),
  sliceIndex: z.number().int().nonnegative().nullable(), sliceTotal: z.number().int().positive().nullable(), sliceTitle: z.string().nullable(),
  feedback: z.array(z.string()).default([]), handoff: z.string().nullable().default(null),
  pendingCommand: WorkflowCommandSchema.nullable().default(null), lastConsumedCommandId: z.string().nullable().default(null),
  verification: VerificationGateSchema.default(inactiveVerificationGate),
  recovery: WorkflowRecoverySchema.default(inactiveWorkflowRecovery),
  attemptPhase: z.enum(attemptPhases).nullable().default(null),
  designRefinementAttempt: z.number().int().nonnegative().default(0),
  repairAttempt: z.number().int().nonnegative(), recoveryCategory: z.string().nullable(), detail: z.string(),
  version: z.number().int().positive(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
});
export type WorkflowState = z.infer<typeof WorkflowStateSchema>;


export type EngineeringRole = (typeof engineeringRoles)[number];
export type EngineeringDiscipline = (typeof engineeringDisciplines)[number];

export const SpecialistPackRefSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  discipline: z.enum(engineeringDisciplines),
});
export type SpecialistPackRef = z.infer<typeof SpecialistPackRefSchema>;

export const TaskCheckpointSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  sessionId: z.string().min(1).nullable(),
  name: z.string().min(1).max(200),
  kind: z.enum(checkpointKinds),
  taskState: z.enum(taskStates),
  mode: z.enum(permissionModes),
  repositoryPath: z.string().nullable(),
  worktreePath: z.string().nullable(),
  baseCommit: z.string().nullable(),
  headCommit: z.string().nullable(),
  approvalId: z.string().nullable(),
  approvalStatus: z.enum(approvalStatuses).nullable(),
  planText: z.string(),
  contextSummary: z.string(),
  completedSteps: z.array(z.string()),
  remainingSteps: z.array(z.string()),
  lastEventId: z.string().nullable(),
  activeRole: z.enum(engineeringRoles).nullable(),
  specialistPacks: z.array(SpecialistPackRefSchema).default([]),
  workflowVersion: z.number().int().positive().nullable().default(null),
  verification: VerificationGateSchema.default(inactiveVerificationGate),
  recovery: WorkflowRecoverySchema.default(inactiveWorkflowRecovery),
  attemptPhase: z.enum(attemptPhases).nullable().default(null),
  designRefinementAttempt: z.number().int().nonnegative().default(0),
  createdAt: z.string().datetime(),
});
export type TaskCheckpoint = z.infer<typeof TaskCheckpointSchema>;

export const TaskContinuationSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  checkpointId: z.string().min(1),
  parentContinuationId: z.string().min(1).nullable(),
  reason: z.string().min(1).max(1000),
  status: z.enum(continuationStatuses),
  restoredMode: z.enum(permissionModes),
  previousState: z.enum(taskStates),
  resultingState: z.enum(taskStates),
  repositoryState: z.enum(repositoryRecoveryStates),
  resumeAction: z.enum(continuationActions),
  detail: z.string(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
});
export type TaskContinuation = z.infer<typeof TaskContinuationSchema>;

export const RoleAssignmentSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  role: z.enum(engineeringRoles),
  discipline: z.enum(engineeringDisciplines),
  status: z.enum(roleAssignmentStatuses),
  model: z.string().min(1).nullable(),
  attempt: z.number().int().nonnegative(),
  capabilities: z.array(z.string().min(1)),
  specialistPacks: z.array(SpecialistPackRefSchema).default([]),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});
export type RoleAssignment = z.infer<typeof RoleAssignmentSchema>;

export const HandoffSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  fromRole: z.enum(engineeringRoles),
  toRole: z.enum(engineeringRoles),
  objective: z.string().min(1),
  constraints: z.array(z.string()),
  repositoryContext: z.array(z.string()),
  completedWork: z.array(z.string()),
  changedFiles: z.array(z.string()),
  evidence: z.array(z.string()),
  openRisks: z.array(z.string()),
  requiredNextAction: z.string().min(1),
  createdAt: z.string().datetime(),
});
export type Handoff = z.infer<typeof HandoffSchema>;

export function createRoleAssignment(input: {
  id: string;
  taskId: string;
  role: EngineeringRole;
  discipline: EngineeringDiscipline;
  model: string | null;
  attempt?: number;
  capabilities: readonly string[];
  specialistPacks?: readonly SpecialistPackRef[];
}): RoleAssignment {
  const now = new Date().toISOString();
  return RoleAssignmentSchema.parse({
    ...input,
    capabilities: [...input.capabilities],
    specialistPacks: [...(input.specialistPacks ?? [])],
    attempt: input.attempt ?? 0,
    status: "active",
    createdAt: now,
    startedAt: now,
    completedAt: null,
  });
}

export function createHandoff(input: Omit<Handoff, "createdAt">): Handoff {
  return HandoffSchema.parse({ ...input, createdAt: new Date().toISOString() });
}

export function createTask(input: Pick<Task, "id" | "projectId" | "request"> & Partial<Pick<Task, "riskLevel">>): Task {
  const now = new Date().toISOString();
  return TaskSchema.parse({ ...input, state: "CREATED", riskLevel: input.riskLevel ?? "R1", disciplines: [], languages: [], frameworks: [], platforms: [], attempts: 0, createdAt: now, updatedAt: now });
}

export function createApproval(input: Pick<Approval, "id" | "taskId">): Approval {
  return ApprovalSchema.parse({ ...input, status: "REQUESTED", requestedAt: new Date().toISOString(), decidedAt: null, worktreePath: null, baseCommit: null });
}


export function createTaskCheckpoint(
  input: Omit<TaskCheckpoint, "createdAt" | "workflowVersion" | "verification" | "recovery" | "attemptPhase" | "designRefinementAttempt">
    & Partial<Pick<TaskCheckpoint, "workflowVersion" | "verification" | "recovery" | "attemptPhase" | "designRefinementAttempt">>,
): TaskCheckpoint {
  return TaskCheckpointSchema.parse({ ...input, createdAt: new Date().toISOString() });
}

export function createTaskContinuation(input: Omit<TaskContinuation, "startedAt" | "completedAt"> & { completed?: boolean }): TaskContinuation {
  const now = new Date().toISOString();
  const { completed, ...value } = input;
  return TaskContinuationSchema.parse({ ...value, startedAt: now, completedAt: completed ? now : null });
}

export function createReviewRun(input: Omit<ReviewRun, "startedAt" | "completedAt"> & { completed?: boolean }): ReviewRun {
  const now = new Date().toISOString();
  const { completed, ...value } = input;
  return ReviewRunSchema.parse({ ...value, startedAt: now, completedAt: completed ? now : null });
}
