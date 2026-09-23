import { z } from "zod";
import type { Task, TaskEvent } from "./contracts.ts";

export const workflowEventCategories = ["lifecycle", "approval", "verification", "recovery", "delivery", "context", "review", "tool", "checkpoint", "activity", "runtime"] as const;
export const workflowEventKinds = [
  "workflow.started",
  "workflow.transitioned",
  "approval.requested",
  "approval.decided",
  "verification.completed",
  "recovery.updated",
  "delivery.updated",
  "context.updated",
  "review.updated",
  "tool.updated",
  "checkpoint.updated",
  "activity.updated",
  "runtime.updated",
] as const;
export const workflowEventStatuses = ["info", "active", "waiting", "succeeded", "failed", "blocked"] as const;

export const WorkflowEventSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  projectId: z.string().min(1),
  workflowVersion: z.number().int().positive().nullable(),
  category: z.enum(workflowEventCategories),
  kind: z.enum(workflowEventKinds),
  status: z.enum(workflowEventStatuses),
  title: z.string().min(1),
  detail: z.string(),
  sourceType: z.string().min(1),
  occurredAt: z.string().datetime(),
  data: z.record(z.string(), z.unknown()),
});
export type WorkflowEvent = z.infer<typeof WorkflowEventSchema>;

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function titleize(type: string) {
  return type.toLowerCase().split("_").filter(Boolean).map((word) => word[0]?.toUpperCase() + word.slice(1)).join(" ");
}

function statusFor(event: TaskEvent): WorkflowEvent["status"] {
  const type = event.type;
  if (type === "VERIFICATION_COMPLETED") {
    const gate = event.payload.gate as { status?: string } | undefined;
    const verification = event.payload.verification as { passed?: boolean } | undefined;
    const passed = gate?.status === "passed" || verification?.passed === true;
    return passed ? "succeeded" : "failed";
  }
  if (type === "TASK_STATE_CHANGED") {
    const target = String(event.payload.to ?? "");
    if (target === "BLOCKED" || target === "RECOVERY_REQUIRED") return "blocked";
    if (target === "FAILED" || target === "CANCELLED") return "failed";
    if (target === "AWAITING_APPROVAL") return "waiting";
    if (target === "COMPLETE" || target === "DELIVERY_READY") return "succeeded";
    return "active";
  }
  if (type.includes("RECOVERY_REQUIRED")) return "blocked";
  if (type === "VISUAL_RENDER_NO_PROGRESS") return "failed";
  if (/(FAILED|FAILURE|BLOCKED|REJECTED|LIMIT_REACHED)$/.test(type)) return type.includes("BLOCKED") || type.includes("LIMIT_REACHED") ? "blocked" : "failed";
  if (/(COMPLETED|APPROVED|READY|ACCEPTED)$/.test(type)) return "succeeded";
  if (/(STARTED|SCHEDULED|SELECTED|ACTIVITY|STATE_CHANGED)$/.test(type)) return "active";
  if (/(REQUESTED|AWAITING)/.test(type)) return "waiting";
  return "info";
}

function eventShape(type: string): Pick<WorkflowEvent, "category" | "kind"> {
  if (type === "TASK_CREATED") return { category: "lifecycle", kind: "workflow.started" };
  if (type === "TASK_STATE_CHANGED" || type.startsWith("WORKFLOW_") || type.startsWith("PROJECT_PLAN_") || type === "FRONTEND_SLICE_READY") {
    return { category: "lifecycle", kind: "workflow.transitioned" };
  }
  if (type.startsWith("APPROVAL_")) return { category: "approval", kind: type === "APPROVAL_REQUESTED" ? "approval.requested" : "approval.decided" };
  if (type === "VERIFICATION_COMPLETED" || type.includes("BROWSER_VERIFICATION") || type === "VISUAL_REGRESSION_COMPLETED") {
    return { category: "verification", kind: "verification.completed" };
  }
  if (type.includes("RECOVERY") || type.includes("REPAIR") || type === "IMPLEMENTATION_NO_PROGRESS" || type === "IMPLEMENTATION_FAILURE_CLASSIFIED") {
    return { category: "recovery", kind: "recovery.updated" };
  }
  if (type.startsWith("DELIVERY_") || type === "CHANGESET_CAPTURED") return { category: "delivery", kind: "delivery.updated" };
  if (type === "CONTEXT_PACK_COMPILED" || type === "MODEL_CONTEXT_RECORDED") return { category: "context", kind: "context.updated" };
  if (type.includes("REVIEW") || type.startsWith("VISION_") || type.startsWith("DESIGN_") || type === "VISUAL_RENDER_NO_PROGRESS" || type === "VISUAL_REFINEMENT_RENDER_BASELINE") return { category: "review", kind: "review.updated" };
  if (type.startsWith("TOOL_")) return { category: "tool", kind: "tool.updated" };
  if (type.includes("CHECKPOINT") || type === "TASK_CONTINUED") return { category: "checkpoint", kind: "checkpoint.updated" };
  if (type === "AGENT_ACTIVITY" || type === "EXECUTION_STATE_CHANGED" || type.startsWith("IMPLEMENTATION_BUDGET_")) {
    return { category: "activity", kind: "activity.updated" };
  }
  return { category: "runtime", kind: "runtime.updated" };
}

function detailFor(event: TaskEvent) {
  const payload = event.payload as Record<string, unknown>;
  if (event.type === "TASK_STATE_CHANGED") return `${String(payload.from ?? "unknown")} → ${String(payload.to ?? "unknown")}`;
  if (event.type === "VERIFICATION_COMPLETED") {
    const gate = payload.gate as { status?: string; summary?: string } | undefined;
    const verification = payload.verification as { passed?: boolean } | undefined;
    return gate?.summary || (verification?.passed ? "Verification passed." : "Verification failed.");
  }
  if (event.type === "CONTEXT_PACK_COMPILED") {
    const profile = payload.profile as { kind?: string } | undefined;
    return `Prepared ${profile?.kind ?? "scoped"} context pack.`;
  }
  if (event.type === "MODEL_CONTEXT_RECORDED") return `Saved ${String(payload.role ?? "model")} model input.`;
  if (event.type.startsWith("TOOL_")) return `${String(payload.tool ?? "tool")}`;
  if (event.type === "AGENT_ACTIVITY") {
    const activity = payload.activity as { title?: string; detail?: string } | undefined;
    return text(activity?.detail) || text(activity?.title) || "Agent activity.";
  }
  return text(payload.message) || text(payload.reason) || text(payload.detail) || titleize(event.type);
}

export function normalizeWorkflowEvent(task: Task, event: TaskEvent): WorkflowEvent {
  const shape = eventShape(event.type);
  const rawVersion = event.payload.workflowVersion;
  return WorkflowEventSchema.parse({
    id: event.id,
    taskId: event.taskId,
    projectId: task.projectId,
    workflowVersion: typeof rawVersion === "number" && Number.isInteger(rawVersion) && rawVersion > 0 ? rawVersion : null,
    ...shape,
    status: statusFor(event),
    title: titleize(event.type),
    detail: detailFor(event),
    sourceType: event.type,
    occurredAt: event.occurredAt,
    data: event.payload,
  });
}

export function normalizeWorkflowEvents(task: Task, events: readonly TaskEvent[]): WorkflowEvent[] {
  return events.map((event) => normalizeWorkflowEvent(task, event));
}
