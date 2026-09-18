import type { Task, TaskEvent } from "../../../packages/core/src/contracts.ts";
import type { ProjectPlan, SliceState } from "../../../packages/web-builder/src/slice-docs.ts";

const steps = ["IMPLEMENTATION_RESPONSE_COMPLETED", "VERIFICATION_COMPLETED", "REVIEW_COMPLETED", "FRONTEND_SLICE_READY", "DELIVERY_READY"];
const visibleEvents = new Set(["AGENT_ACTIVITY", "TOOL_STARTED", "TOOL_COMPLETED", "TOOL_FAILED", "VERIFICATION_COMPLETED", "FRONTEND_SLICE_READY", "RUNTIME_FAILED", "REPAIR_LIMIT_REACHED", "MODEL_CONTEXT_RECORDED"]);

function activityDetail(event: TaskEvent) {
  if (event.type === "AGENT_ACTIVITY") return (event.payload.activity as { title?: string } | undefined)?.title ?? "Agent activity";
  if (event.type.startsWith("TOOL_")) return `${event.type === "TOOL_FAILED" ? "Failed" : event.type === "TOOL_COMPLETED" ? "Completed" : "Started"}: ${String(event.payload.tool ?? "tool")}`;
  if (event.type === "VERIFICATION_COMPLETED") return (event.payload.verification as { passed?: boolean } | undefined)?.passed ? "Verification passed" : "Verification failed";
  if (event.type === "MODEL_CONTEXT_RECORDED") return `Saved ${String(event.payload.role ?? "model")} input`;
  return event.type.replaceAll("_", " ").toLowerCase();
}

export function deriveWorkflowStatus(task: Task, events: TaskEvent[], plan: ProjectPlan | null, slice: SliceState | null) {
  const latestActivity = events.findLast((event) => event.type === "AGENT_ACTIVITY");
  const latestVerification = events.findLast((event) => event.type === "VERIFICATION_COMPLETED");
  const completed = steps.filter((type) => events.some((event) => event.type === type));
  const terminal = ["COMPLETE", "BLOCKED", "FAILED", "DELIVERY_READY"].includes(task.state);
  const nextAction = task.state === "AWAITING_APPROVAL" ? "Review and approve the frontend plan."
    : task.state === "BLOCKED" || task.state === "FAILED" ? "Inspect the failure and resume from a safe checkpoint."
    : task.state === "DELIVERY_READY" ? "Save the verified slice checkpoint."
    : task.state === "COMPLETE" && slice?.status === "awaiting_feedback" ? "Start the next approved slice automatically."
    : task.state === "COMPLETE" ? "Review the completed frontend."
    : task.state === "VERIFYING" ? "Review verification results."
    : "Continue the current task.";
  return {
    taskId: task.id,
    taskState: task.state,
    phase: "frontend" as const,
    sliceIndex: slice?.current ?? null,
    sliceTotal: slice?.total ?? null,
    sliceTitle: slice?.currentTitle ?? null,
    objective: plan && slice ? plan.slices[slice.current]?.outcome ?? task.request : task.request,
    currentAction: terminal ? task.state.toLowerCase().replaceAll("_", " ") : (latestActivity?.payload.activity as { title?: string } | undefined)?.title ?? task.state.toLowerCase().replaceAll("_", " "),
    completed,
    pending: steps.filter((type) => !completed.includes(type)),
    verificationPassed: (latestVerification?.payload.verification as { passed?: boolean } | undefined)?.passed ?? null,
    repairAttempt: task.attempts,
    nextAction,
    activity: events.filter((event) => visibleEvents.has(event.type)).slice(-80).map((event) => ({
      type: event.type,
      occurredAt: event.occurredAt,
      detail: activityDetail(event),
    })),
  };
}
