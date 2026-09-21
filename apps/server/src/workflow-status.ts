import type { Task, TaskEvent, WorkflowState } from "../../../packages/core/src/contracts.ts";
import { normalizeWorkflowEvents } from "../../../packages/core/src/workflow-events.ts";
import type { ProjectPlan, SliceState } from "../../../packages/web-builder/src/slice-docs.ts";

const steps = ["IMPLEMENTATION_RESPONSE_COMPLETED", "VERIFICATION_COMPLETED", "REVIEW_COMPLETED", "FRONTEND_SLICE_READY", "DELIVERY_READY"];
const visibleCategories = new Set(["lifecycle", "approval", "verification", "recovery", "delivery", "context", "review", "tool", "checkpoint", "activity"]);

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
  recovery: { status: string; category: string | null; previousTaskState: string | null; checkpointId: string | null; resumeAction: string; reason: string } | null;
  repair: { attempt: number; maximum: number | null } | null;
  planRevision: {
    from: number;
    to: number;
    repairScope: string;
    reason: string;
    delta: {
      addedPages: string[];
      removedPages: string[];
      changedPages: string[];
      addedSlices: string[];
      removedSlices: string[];
      changedSlices: string[];
    };
  } | null;
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
  if (event.type === "DESIGN_REFINEMENT_LIMIT_REACHED") return "Visual review still requires structural refinement after the bounded refinement limit.";
  if (event.type === "PLAN_REPAIR_REQUIRED") return String(event.payload.reason ?? "The approved plan cannot satisfy the current product-quality findings.");
  if (event.type === "CONTEXT_PACK_COMPILED") return `Prepared ${String((event.payload.profile as { kind?: string } | undefined)?.kind ?? "scoped")} context pack`;
  if (event.type === "MODEL_CONTEXT_RECORDED") return `Saved ${String(event.payload.role ?? "model")} input`;
  if (event.type === "IMPLEMENTATION_BUDGET_CONTINUATION") return "Implementation budget reached; continuing the same slice with compact context";
  if (event.type === "IMPLEMENTATION_BUDGET_EXHAUSTED") return "Implementation budget exhausted; completion must be proven by verification";
  if (event.type === "EXECUTION_STATE_CHANGED") return `${String(event.payload.state ?? "execution").replaceAll("_", " ")} · repair ${Number(event.payload.repairAttempt ?? 0)}`;
  if (event.type === "REPAIR_CONTEXT_CREATED") return "Compiled bounded repair evidence";
  return event.type.replaceAll("_", " ").toLowerCase();
}

function stageFor(task: Task, events: TaskEvent[], slice: SliceState | null, workflow: WorkflowState | null): RunStage {
  if (["BLOCKED", "FAILED", "RECOVERY_REQUIRED"].includes(task.state)) return "blocked";
  if (["PAUSED", "CANCELLED"].includes(task.state)) return "paused";
  if (task.state === "AWAITING_APPROVAL") return "awaiting_approval";
  if (task.state === "IMPLEMENTING") {
    const durableRepair = workflow?.attemptPhase === "technical_repair" || workflow?.attemptPhase === "design_refinement";
    return durableRepair || task.attempts > 0 ? "repairing" : "implementing";
  }
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

function latestBlocker(task: Task, events: TaskEvent[], nextAction: string, workflow: WorkflowState | null): RunView["blocker"] {
  if (!["BLOCKED", "FAILED", "RECOVERY_REQUIRED"].includes(task.state)) return null;
  const reversed = [...events].reverse();
  const authoritative = reversed.find((candidate) =>
    [
      "PLAN_REPAIR_REQUIRED",
      "DESIGN_REFINEMENT_LIMIT_REACHED",
      "REPAIR_LIMIT_REACHED",
      "DESIGN_REVIEW_BLOCKED",
      "TASK_RECOVERY_REQUIRED",
      "WORKSPACE_PREFLIGHT_BLOCKED",
      "RUNTIME_FAILED",
    ].includes(candidate.type),
  );
  const event = authoritative ?? reversed.find((candidate) => candidate.type === "TOOL_FAILED");
  const payload = event?.payload as Record<string, unknown> | undefined;
  const durableRecovery = workflow?.recovery.status !== "inactive" ? workflow?.recovery : null;
  const refinementSummary = event?.type === "DESIGN_REFINEMENT_LIMIT_REACHED"
    ? (payload?.review as { summary?: string } | undefined)?.summary
    : null;
  const detail = durableRecovery?.reason
    || refinementSummary
    || String(payload?.message ?? payload?.reason ?? payload?.detail ?? (event ? activityDetail(event) : "The current run cannot continue automatically."));
  const planRepair = event?.type === "PLAN_REPAIR_REQUIRED" || durableRecovery?.category === "plan_repair_required";
  const refinementLimit = event?.type === "DESIGN_REFINEMENT_LIMIT_REACHED";
  return {
    title: planRepair
      ? "Plan repair required"
      : refinementLimit
        ? "Design refinement limit reached"
        : task.state === "RECOVERY_REQUIRED"
          ? "Recovery required"
          : task.state === "FAILED"
            ? "Run failed"
            : "Quality gate blocked the build",
    detail,
    action: planRepair ? "Replan the affected frontend scope before resuming implementation." : durableRecovery?.resumeAction ?? nextAction,
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
  const normalizedEvents = normalizeWorkflowEvents(task, events);
  const latestActivity = events.findLast((event) => event.type === "AGENT_ACTIVITY");
  const latestVerification = events.findLast((event) => event.type === "VERIFICATION_COMPLETED");
  const latestVisual = events.findLast((event) =>
    event.type === "DESIGN_REVIEW_COMPLETED"
    || event.type === "DESIGN_REVIEW_BLOCKED"
    || event.type === "DESIGN_REFINEMENT_LIMIT_REACHED"
    || event.type === "PLAN_REPAIR_REQUIRED"
    || event.type === "VISUAL_REGRESSION_COMPLETED");
  const revisionEvent = events.findLast((event) => event.type === "PROJECT_PLAN_REVISION_PROPOSED");
  const revisionPayload = revisionEvent?.payload as {
    delta?: {
      fromRevision?: number; toRevision?: number;
      addedPages?: string[]; removedPages?: string[]; changedPages?: string[];
      addedSlices?: string[]; removedSlices?: string[]; changedSlices?: string[];
    };
    repairScope?: string;
    reason?: string;
  } | undefined;
  const revisionDelta = revisionPayload?.delta;
  const planRevision = revisionDelta && Number.isFinite(revisionDelta.fromRevision) && Number.isFinite(revisionDelta.toRevision)
    ? {
        from: Number(revisionDelta.fromRevision),
        to: Number(revisionDelta.toRevision),
        repairScope: String(revisionPayload?.repairScope ?? "project_plan"),
        reason: String(revisionPayload?.reason ?? "The approved plan required structural repair."),
        delta: {
          addedPages: revisionDelta.addedPages ?? [],
          removedPages: revisionDelta.removedPages ?? [],
          changedPages: revisionDelta.changedPages ?? [],
          addedSlices: revisionDelta.addedSlices ?? [],
          removedSlices: revisionDelta.removedSlices ?? [],
          changedSlices: revisionDelta.changedSlices ?? [],
        },
      }
    : null;
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
  const stage = baselineApprovalCount > 0 ? "awaiting_approval" as const : stageFor(task, events, slice, workflow);
  const activeSlice = plan && slice ? plan.slices[slice.current] ?? null : null;
  const legacyVerificationPassed = (latestVerification?.payload.verification as { passed?: boolean } | undefined)?.passed ?? null;
  const verificationPassed = workflow
    ? workflow.verification.status === "passed"
      ? true
      : workflow.verification.status === "failed"
        ? false
        : null
    : legacyVerificationPassed;
  const visualStatus = latestVisual?.type === "VISUAL_REGRESSION_COMPLETED"
    ? String((latestVisual.payload.report as { status?: string } | undefined)?.status ?? "completed")
    : latestVisual?.type === "DESIGN_REFINEMENT_LIMIT_REACHED"
      ? "refinement_limit"
      : latestVisual?.type === "PLAN_REPAIR_REQUIRED"
        ? "plan_repair_required"
        : latestVisual
          ? String((latestVisual.payload.review as { status?: string } | undefined)?.status ?? (latestVisual.type === "DESIGN_REVIEW_BLOCKED" ? "blocked" : "completed"))
          : null;
  const detail = baselineApprovalCount > 0
    ? `${baselineApprovalCount} verified screenshot baseline candidate(s) need explicit operator acceptance before delivery. BORG never updates visual baselines automatically.`
    : workflow?.recovery.status !== "inactive" && workflow?.recovery.reason
      ? workflow.recovery.reason
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
    headline: baselineApprovalCount > 0
      ? "Visual baseline approval required"
      : stage === "awaiting_approval" && planRevision
        ? `Plan revision ${planRevision.from} → ${planRevision.to} ready for approval`
        : headlineFor(stage, slice),
    detail,
    currentAction,
    verification: {
      status: verificationPassed === null ? "pending" : verificationPassed ? "passed" : "failed",
      visualStatus,
    },
    recovery: workflow && workflow.recovery.status !== "inactive" ? workflow.recovery : null,
    repair: task.attempts > 0 ? { attempt: task.attempts, maximum: null } : null,
    planRevision,
    blocker: null,
    nextAction,
    updatedAt: workflow?.updatedAt ?? task.updatedAt,
  };
  run.blocker = latestBlocker(task, events, nextAction, workflow);

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
    recovery: workflow?.recovery ?? null,
    run,
    activity: normalizedEvents.filter((event) => visibleCategories.has(event.category)).slice(-80).map((event) => ({
      type: event.kind,
      sourceType: event.sourceType,
      category: event.category,
      status: event.status,
      title: event.title,
      occurredAt: event.occurredAt,
      detail: event.detail,
    })),
  };
}
