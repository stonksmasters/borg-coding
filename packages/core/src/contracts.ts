import { z } from "zod";
import { permissionModes } from "./chat-session.ts";

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

export const TaskEventSchema = z.object({ id: z.string().min(1), taskId: z.string().min(1), type: z.string().min(1), payload: z.record(z.string(), z.unknown()), occurredAt: z.string().datetime() });
export type TaskEvent = z.infer<typeof TaskEventSchema>;


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


export function createTaskCheckpoint(input: Omit<TaskCheckpoint, "createdAt">): TaskCheckpoint {
  return TaskCheckpointSchema.parse({ ...input, createdAt: new Date().toISOString() });
}

export function createTaskContinuation(input: Omit<TaskContinuation, "startedAt" | "completedAt"> & { completed?: boolean }): TaskContinuation {
  const now = new Date().toISOString();
  const { completed, ...value } = input;
  return TaskContinuationSchema.parse({ ...value, startedAt: now, completedAt: completed ? now : null });
}

