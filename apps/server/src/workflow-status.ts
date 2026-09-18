import type { Task, TaskEvent } from "../../../packages/core/src/contracts.ts";
import type { ProjectPlan, SliceState } from "../../../packages/web-builder/src/slice-docs.ts";

const steps = ["IMPLEMENTATION_RESPONSE_COMPLETED", "VERIFICATION_COMPLETED", "REVIEW_COMPLETED", "FRONTEND_SLICE_READY", "DELIVERY_READY"];
const visibleEvents = new Set([
  "AGENT_ACTIVITY",
  "TOOL_STARTED",
  "TOOL_COMPLETED",
  "TOOL_FAILED",
  "WORKSPACE_PREFLIGHT_COMPLETED",
  "WORKSPACE_PREFLIGHT_BLOCKED",
  "IMPLEMENTATION_FAILURE_CLASSIFIED",
  "IMPLEMENTATION_NO_PROGRESS",
  "IMPLEMENTATION_RECOVERY_SCHEDULED",
  "VERIFICATION_COMPLETED",
  "FRONTEND_SLICE_READY",
  "RUNTIME_FAILED",
  "REPAIR_LIMIT_REACHED",
  "MODEL_CONTEXT_RECORDED",
]);

function activityDetail(event: TaskEvent) {
  if (event.type === "AGENT_ACTIVITY") return (event.payload.activity as { title?: string } | undefined)?.title ?? "Agent activity";
  if (event.type.startsWith("TOOL_")) return `${event.type === "TOOL_FAILED" ? "Failed" : event.type === "TOOL_COMPLETED" ? "Completed" : "Started"}: ${String(event.payload.tool ?? "tool")}`;
  if (event.type === "WORKSPACE_PREFLIGHT_COMPLETED") {
    const report = event.payload.report as { passed?: boolean; contract?: { kind?: string }; repairedDirectories?: string[] } | undefined;
    const repaired = report?.repairedDirectories?.length ?? 0;
    return `Workspace preflight ${report?.passed ? "passed" : "failed"} · ${report?.contract?.kind ?? "unknown"}${repaired ? ` · repaired ${repaired} director${repaired === 1 ? "y" : "ies"}` : ""}`;
  }
  if (event.type === "WORKSPACE_PREFLIGHT_BLOCKED") return "Workspace preflight blocked unsafe execution";
  if (event.type === "IMPLEMENTATION_FAILURE_CLASSIFIED") {
    const decision = event.payload.decision as { category?: string; disposition?: string } | undefined;
    return `Failure classified as ${decision?.category ?? "unknown"} · ${decision?.disposition ?? "fatal"}`;
  }
  if (event.type === "IMPLEMENTATION_NO_PROGRESS") return "Implementation made no source progress; recovery evaluation started";
  if (event.type === "IMPLEMENTATION_RECOVERY_SCHEDULED") {
    return `Recovery scheduled · ${String(event.payload.category ?? "recoverable")} · attempt ${String(event.payload.attempt ?? "?")}/${String(event.payload.maximum ?? "?")}`;
  }
  if (event.type === "VERIFICATION_COMPLETED") return (event.payload.verification as { passed?: boolean } | undefined)?.passed ? "Verification passed" : "Verification failed";
  if (event.type === "MODEL_CONTEXT_RECORDED") return `Saved ${String(event.payload.role ?? "model")} input`;
  return event.type.replaceAll("_", " ").toLowerCase();
}

export function deriveWorkflowStatus(task: Task, events: TaskEvent[], plan: ProjectPlan | null, slice: SliceState | null) {
  const latestActivity = events.findLast((event) => event.type === "AGENT_ACTIVITY");
  const latestVerification = events.findLast((event) => event.type === "VERIFICATION_COMPLETED");
  const latestRecoveryIndex = events.findLastIndex((event) => event.type === "IMPLEMENTATION_RECOVERY_SCHEDULED");
  const latestProgressIndex = Math.max(
    events.findLastIndex((event) => event.type === "IMPLEMENTATION_RESPONSE_COMPLETED"),
    events.findLastIndex((event) => event.type === "REPAIR_RESPONSE_COMPLETED"),
    events.findLastIndex((event) => event.type === "VERIFICATION_COMPLETED"),
  );
  const latestRecovery = latestRecoveryIndex >= 0 ? events[latestRecoveryIndex] : null;
  const recoveryActive = task.state === "IMPLEMENTING" && latestRecoveryIndex > latestProgressIndex;
  const latestPreflight = events.findLast((event) => event.type === "WORKSPACE_PREFLIGHT_COMPLETED");
  const preflightReport = latestPreflight?.payload.report as {
    passed?: boolean;
    reason?: string;
    contract?: { kind?: string };
    repairedDirectories?: string[];
    dependencyState?: string;
    issues?: Array<{ severity?: string; message?: string }>;
  } | undefined;
  const completed = steps.filter((type) => events.some((event) => event.type === type));
  const terminal = ["COMPLETE", "BLOCKED", "FAILED", "DELIVERY_READY"].includes(task.state);
  const nextAction = task.state === "AWAITING_APPROVAL" ? "Review and approve the frontend plan."
    : task.state === "BLOCKED" || task.state === "FAILED" ? "Inspect the failure and resume from a safe checkpoint."
    : task.state === "DELIVERY_READY" ? "Save the verified slice checkpoint."
    : task.state === "COMPLETE" && slice?.status === "awaiting_feedback" ? "Start the next approved slice automatically."
    : task.state === "COMPLETE" ? "Review the completed frontend."
    : recoveryActive ? "Continue the same approved slice using the compact recovery evidence."
    : task.state === "VERIFYING" ? "Review verification results."
    : "Continue the current task.";
  const recovery = latestRecovery ? {
    active: recoveryActive,
    attempt: Number(latestRecovery.payload.attempt ?? task.attempts),
    maximum: Number(latestRecovery.payload.maximum ?? 0),
    category: String(latestRecovery.payload.category ?? "recoverable"),
    reason: String(latestRecovery.payload.reason ?? "Recoverable implementation failure."),
    action: String(latestRecovery.payload.action ?? "Retry the current slice."),
  } : null;
  const currentAction = recoveryActive
    ? `Recovery active · retrying slice ${slice ? slice.current + 1 : "?"} (${recovery?.attempt ?? task.attempts}/${recovery?.maximum ?? "?"})`
    : terminal
      ? task.state.toLowerCase().replaceAll("_", " ")
      : (latestActivity?.payload.activity as { title?: string } | undefined)?.title ?? task.state.toLowerCase().replaceAll("_", " ");

  return {
    taskId: task.id,
    taskState: task.state,
    phase: "frontend" as const,
    sliceIndex: slice?.current ?? null,
    sliceTotal: slice?.total ?? null,
    sliceTitle: slice?.currentTitle ?? null,
    objective: plan && slice ? plan.slices[slice.current]?.outcome ?? task.request : task.request,
    currentAction,
    completed,
    pending: steps.filter((type) => !completed.includes(type)),
    verificationPassed: (latestVerification?.payload.verification as { passed?: boolean } | undefined)?.passed ?? null,
    repairAttempt: task.attempts,
    recovery,
    preflight: preflightReport ? {
      passed: Boolean(preflightReport.passed),
      reason: preflightReport.reason ?? "unknown",
      contract: preflightReport.contract?.kind ?? "unknown",
      repairedDirectories: preflightReport.repairedDirectories ?? [],
      dependencyState: preflightReport.dependencyState ?? "unknown",
      warnings: (preflightReport.issues ?? []).filter((issue) => issue.severity === "warning").map((issue) => issue.message ?? "").filter(Boolean).slice(0, 5),
    } : null,
    nextAction,
    activity: events.filter((event) => visibleEvents.has(event.type)).slice(-80).map((event) => ({
      type: event.type,
      occurredAt: event.occurredAt,
      detail: activityDetail(event),
    })),
  };
}
