import { z } from "zod";

export const taskStates = ["CREATED", "CLASSIFYING", "DISCOVERING", "PLANNING", "AWAITING_APPROVAL", "IMPLEMENTING", "VERIFYING", "REVIEWING", "DELIVERY_READY", "DELIVERING", "COMPLETE", "BLOCKED", "FAILED", "CANCELLED"] as const;
export const riskLevels = ["R0", "R1", "R2", "R3", "R4"] as const;
export const severityLevels = ["info", "low", "medium", "high", "critical"] as const;
export const approvalStatuses = ["REQUESTED", "APPROVED", "REJECTED"] as const;

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

export function createTask(input: Pick<Task, "id" | "projectId" | "request"> & Partial<Pick<Task, "riskLevel">>): Task {
  const now = new Date().toISOString();
  return TaskSchema.parse({ ...input, state: "CREATED", riskLevel: input.riskLevel ?? "R1", disciplines: [], languages: [], frameworks: [], platforms: [], attempts: 0, createdAt: now, updatedAt: now });
}

export function createApproval(input: Pick<Approval, "id" | "taskId">): Approval {
  return ApprovalSchema.parse({ ...input, status: "REQUESTED", requestedAt: new Date().toISOString(), decidedAt: null, worktreePath: null, baseCommit: null });
}
