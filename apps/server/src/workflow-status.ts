import type { Task, TaskEvent, WorkflowState } from "../../../packages/core/src/contracts.ts";
import type { ProjectPlan, SliceState } from "../../../packages/web-builder/src/slice-docs.ts";

const steps = ["IMPLEMENTATION_RESPONSE_COMPLETED", "VERIFICATION_COMPLETED", "REVIEW_COMPLETED", "FRONTEND_SLICE_READY", "DELIVERY_READY"];
const visibleEvents = new Set(["AGENT_ACTIVITY", "TOOL_STARTED", "TOOL_COMPLETED", "TOOL_FAILED", "VERIFICATION_COMPLETED", "VISUAL_REGRESSION_COMPLETED", "DESIGN_REVIEW_COMPLETED", "DESIGN_REVIEW_BLOCKED", "FRONTEND_SLICE_READY", "RUNTIME_FAILED", "REPAIR_LIMIT_REACHED", "MODEL_CONTEXT_RECORDED", "IMPLEMENTATION_BUDGET_CONTINUATION", "IMPLEMENTATION_BUDGET_EXHAUSTED"]);

export type RunStage =
  | "planning"
  | "awaiting_approval"
  | "implementing"
  | "repairing"
  | "verifying"
  | "visual_review"
  | "reviewing"
  | "delivering"
  | "ready"
  | "blocked"
  | "paused";

export interface RunView {
  phase: string;
  slice: { index: number; total: number; title: string; outcome: string } | null;
  stage: RunStage;
  headline: string;
  detail: string;
  currentAction: string;
  verification: { status: "pending" | "passed" | "failed"; visualStatus: string | null };
  repair: { attempt: number; maximum: number | null } | null;
  blocker: { title: string; detail: string; action: string } | null;
  nextAction: string;
  updatedAt: string;
}

function activityDetail(event: TaskEvent) {
  if (event.type === "AGENT_ACTIVITY") return (event.payload.activity as { title?: string } | undefined)?.title ?? "Agent activity";
  if (event.type.startsWith("TOOL_")) return `${event.type === "TOOL_FAILED" ? "Failed" : event.type === "TOOL_COMPLETED" ? "Completed" : "Started"}: ${String(event.payload.tool ?? "tool")}`;
  if (event.type === "VERIFICATION_COMPLETED") return (event.payload.verification as { passed?: boolean } | undefined)?.passed ? "Verification passed" : "Verification failed";
  if (event.type === "VISUAL_REGRESSION_COMPLETED") return `Visual regression: ${String((event.payload.report as { status?: string } | undefined)?.status ?? "completed")}`;
  if (event.type === "DESIGN_REVIEW_COMPLETED") return `Visual review: ${String((event.payload.review as { status?: string } | undefined)?.status ?? "completed")}`;
  if (event.type === "MODEL_CONTEXT_RECORDED") return `Saved ${String(event.payload.role ?? "model")} input`;
  if (event.type === "IMPLEMENTATION_BUDGET_CONTINUATION") return "Implementation budget reached; continuing the same slice with compact context";
  if (event.type === "IMPLEMENTATION_BUDGET_EXHAUSTED") return "Implementation budget exhausted; completion must be proven by verification";
  return event.type.replaceAll("_", " ").toLowerCase();
}

function stageFor(task: Task, events: TaskEvent[], slice: SliceState | null): RunStage {
  if (["BLOCKED", "FAILED", "RECOVERY_REQUIRED"].includes(task.state)) return "blocked";
  if (["PAUSED", "CANCELLED"].includes(task.state)) return "paused";
  if (task.state === "AWAITING_APPROVAL") return "awaiting_approval";
  if (task.state === "IMPLEMENTING") return task.attempts > 0 ? "repairing" : "implementing";
  if (task.state === "VERIFYING") {
    const designStarted = events.findLast((event) => event.type === "DESIGN_REVIEW_STARTED");
    const verification = events.findLast((event) => event.type === "VERIFICATION_COMPLETED");
    if (designStarted && verification && designStarted.occurredAt >= verification.occurredAt) return "visual_review";
    return "verifying";
  }
  if (task.state === "REVIEWING") return "reviewing";
  if (task.state === "DELIVERING") return "delivering";
  if (["DELIVERY_READY", "COMPLETE"].includes(task.state)) {
    if (slice?.status === "working") return "implementing";
    return "ready";
  }
  return "planning";
}

function headlineFor(stage: RunStage, slice: SliceState | null) {
  const subject = slice?.currentTitle || "project";
  switch (stage) {
    case "planning": return `Planning ${subject}`;
    case "awaiting_approval": return "Plan ready for approval";
    case "implementing": return `Building ${subject}`;
    case "repairing": return `Repairing ${subject}`;
    case "verifying": return `Checking ${subject}`;
    case "visual_review": return `Reviewing visual quality for ${subject}`;
    case "reviewing": return `Reviewing ${subject}`;
    case "delivering": return `Saving ${subject}`;
    case "ready": return slice?.status === "frontend_complete" ? "Frontend complete" : `${subject} is verified`;
    case "blocked": return "Build needs attention";
    case "paused": return "Build paused";
  }
}

function latestBlocker(task: Task, events: TaskEvent[], nextAction: string): RunView["blocker"] {
  if (!["BLOCKED", "FAILED", "RECOVERY_REQUIRED"].includes(task.state)) return null;
  const event = [...events].reverse().find((candidate) =>
    ["REPAIR_LIMIT_REACHED", "DESIGN_REVIEW_BLOCKED", "RUNTIME_FAILED", "TOOL_FAILED", "WORKSPACE_PREFLIGHT_BLOCKED"].includes(candidate.type),
  );
  const payload = event?.payload as Record<string, unknown> | undefined;
  const detail = String(payload?.message ?? payload?.reason ?? payload?.detail ?? (event ? activityDetail(event) : "The current run cannot continue automatically."));
  return {
    title: task.state === "RECOVERY_REQUIRED" ? "Recovery required" : task.state === "FAILED" ? "Run failed" : "Quality gate blocked the build",
    detail,
    action: nextAction,
  };
}

export function deriveWorkflowStatus(
  task: Task,
  events: TaskEvent[],
  plan: ProjectPlan | null,
  slice: SliceState | null,
  workflow: WorkflowState | null = null,
  options: { baselineApprovalCount?: number } = {},
) {
  const latestActivity = events.findLast((event) => event.type === "AGENT_ACTIVITY");
  const latestVerification = events.findLast((event) => event.type === "VERIFICATION_COMPLETED");
  const latestVisual = events.findLast((event) => event.type === "DESIGN_REVIEW_COMPLETED" || event.type === "DESIGN_REVIEW_BLOCKED" || event.type === "VISUAL_REGRESSION_COMPLETED");
  const completed = steps.filter((type) => events.some((event) => event.type === type));
  const terminal = ["COMPLETE", "BLOCKED", "FAILED", "DELIVERY_READY"].includes(task.state);
  const fallbackNextAction = task.state === "AWAITING_APPROVAL" ? "Review and approve the frontend plan."
    : task.state === "BLOCKED" || task.state === "FAILED" || task.state === "RECOVERY_REQUIRED" ? "Inspect the blocking evidence and continue from a safe checkpoint."
    : task.state === "DELIVERY_READY" ? "Save the verified slice checkpoint."
    : task.state === "COMPLETE" && slice?.status === "awaiting_feedback" ? "The next approved slice starts automatically."
    : task.state === "COMPLETE" ? "Review the completed frontend."
    : task.state === "VERIFYING" ? "Finish verification and independent review."
    : "Continue the current task.";
  const baselineApprovalCount = options.baselineApprovalCount ?? 0;
  const nextAction = baselineApprovalCount > 0
    ? "Accept the verified visual baseline candidates in Evidence before this slice can be checkpointed."
    : workflow?.nextAction ?? fallbackNextAction;
  const currentAction = baselineApprovalCount > 0
    ? "waiting for visual baseline approval"
    : terminal
      ? task.state.toLowerCase().replaceAll("_", " ")
      : (latestActivity?.payload.activity as { title?: string } | undefined)?.title ?? task.state.toLowerCase().replaceAll("_", " ");
  const stage = baselineApprovalCount > 0 ? "awaiting_approval" as const : stageFor(task, events, slice);
  const activeSlice = plan && slice ? plan.slices[slice.current] ?? null : null;
  const verificationPassed = (latestVerification?.payload.verification as { passed?: boolean } | undefined)?.passed ?? null;
  const visualStatus = latestVisual?.type === "VISUAL_REGRESSION_COMPLETED"
    ? String((latestVisual.payload.report as { status?: string } | undefined)?.status ?? "completed")
    : latestVisual
      ? String((latestVisual.payload.review as { status?: string } | undefined)?.status ?? (latestVisual.type === "DESIGN_REVIEW_BLOCKED" ? "blocked" : "completed"))
      : null;
  const detail = baselineApprovalCount > 0
    ? `${baselineApprovalCount} verified screenshot baseline candidate(s) need explicit operator acceptance before delivery. BORG never updates visual baselines automatically.`
    : workflow?.detail
      ?? (latestActivity?.payload.activity as { detail?: string } | undefined)?.detail
      ?? (stage === "ready" ? "The current product boundary has passed its required checks." : "BORG is continuing the current persisted workflow.");
  const run: RunView = {
    phase: workflow?.phase ?? "frontend",
    slice: slice ? {
      index: slice.current,
      total: slice.total,
      title: slice.currentTitle,
      outcome: activeSlice?.outcome ?? task.request,
    } : null,
    stage,
    headline: baselineApprovalCount > 0 ? "Visual baseline approval required" : headlineFor(stage, slice),
    detail,
    currentAction,
    verification: {
      status: verificationPassed === null ? "pending" : verificationPassed ? "passed" : "failed",
      visualStatus,
    },
    repair: task.attempts > 0 ? { attempt: task.attempts, maximum: null } : null,
    blocker: null,
    nextAction,
    updatedAt: workflow?.updatedAt ?? task.updatedAt,
  };
  run.blocker = latestBlocker(task, events, nextAction);

  return {
    taskId: task.id,
    taskState: task.state,
    source: workflow ? "sqlite" as const : "legacy_projection" as const,
    workflowVersion: workflow?.version ?? null,
    phase: workflow?.phase ?? "frontend",
    status: workflow?.status ?? task.state.toLowerCase(),
    sliceIndex: workflow?.sliceIndex ?? slice?.current ?? null,
    sliceTotal: workflow?.sliceTotal ?? slice?.total ?? null,
    sliceTitle: workflow?.sliceTitle ?? slice?.currentTitle ?? null,
    objective: activeSlice?.outcome ?? task.request,
    currentAction,
    completed,
    pending: steps.filter((type) => !completed.includes(type)),
    verificationPassed,
    repairAttempt: workflow?.repairAttempt ?? task.attempts,
    nextAction,
    detail: workflow?.detail ?? null,
    run,
    activity: events.filter((event) => visibleEvents.has(event.type)).slice(-80).map((event) => ({
      type: event.type,
      occurredAt: event.occurredAt,
      detail: activityDetail(event),
    })),
  };
}
