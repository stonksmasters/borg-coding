import { randomUUID } from "node:crypto";
import {
  WorkflowStateSchema,
  inactiveVerificationGate,
  inactiveWorkflowRecovery,
  type Approval,
  type Task,
  type TaskCheckpoint,
  type TaskContinuation,
  type TaskEvent,
  type TaskState,
  type WorkflowProjectPlan,
  type WorkflowState,
} from "./contracts.ts";
import { assertTransition } from "./state-machine.ts";
import type { RecoveryDecision } from "./recovery-service.ts";

export type WorkflowMutation = {
  state: WorkflowState;
  task?: Task;
  approval?: Approval;
  continuation?: TaskContinuation;
  events?: TaskEvent[];
};

export interface WorkflowStore {
  findWorkflow(projectId: string): WorkflowState | null;
  commitWorkflowMutation(input: WorkflowMutation): void;
}

export type WorkflowIntent = "project_plan" | "frontend_slice" | "backend" | "general";
export type FrontendSliceAction = "initial" | "advance" | "revise";
export type VerificationRecordInput = {
  passed: boolean;
  attempt: number;
  profile?: string | null;
  summary: string;
  browserPassed?: boolean | null;
  specialistPassed?: boolean | null;
  resultSha256?: string | null;
  evidence?: unknown;
};

function loopForIntent(intent: WorkflowIntent): WorkflowState["loop"] {
  return intent === "project_plan" ? "project"
    : intent === "frontend_slice" ? "slice"
      : intent === "backend" ? "backend"
        : "general";
}

function selectFrontendSlice(
  existing: WorkflowState | null,
  action: FrontendSliceAction | undefined,
  commandId: string | null | undefined,
) {
  if (!existing?.projectPlan || !existing.planApproved || existing.projectPlan.status === "proposed") {
    throw new Error("Frontend slices require an approved durable project plan.");
  }
  if (!action) throw new Error("Frontend slice start requires an explicit slice action.");

  if (action === "revise") {
    if (commandId) throw new Error("Slice revision must not claim a start/advance command.");
    if (existing.sliceIndex === null) throw new Error("No frontend slice exists to revise.");
    if (existing.nextAction !== "request_feedback" && existing.nextAction !== "advance_slice") {
      throw new Error("Only a checkpointed slice awaiting feedback may be revised.");
    }
    const slice = existing.projectPlan.slices[existing.sliceIndex];
    if (!slice) throw new Error(`Frontend slice ${existing.sliceIndex + 1} is outside the approved plan.`);
    return {
      index: existing.sliceIndex,
      total: existing.projectPlan.slices.length,
      title: slice.title,
      command: null,
      supersededCommandId: existing.pendingCommand?.id ?? null,
    };
  }

  const expectedAction = action === "initial" ? "start_slice" : "advance_slice";
  if (!commandId) throw new Error(`Frontend slice ${action} requires Core's pending ${expectedAction} command.`);
  const pending = existing.pendingCommand;
  if (!pending || pending.id !== commandId || pending.action !== expectedAction) {
    if (existing.lastConsumedCommandId === commandId) throw new Error(`Workflow command ${commandId} was already consumed.`);
    throw new Error(`Workflow command ${commandId} is no longer pending for ${expectedAction}.`);
  }
  if (pending.claimedByTaskId) throw new Error(`Workflow command ${commandId} is already claimed by task ${pending.claimedByTaskId}.`);

  const fallbackIndex = action === "initial" ? (existing.sliceIndex ?? 0) : (existing.sliceIndex ?? -1) + 1;
  const index = pending.targetSliceIndex ?? fallbackIndex;
  const slice = existing.projectPlan.slices[index];
  if (!slice) throw new Error(`Frontend slice ${index + 1} is outside the approved plan.`);
  return {
    index,
    total: existing.projectPlan.slices.length,
    title: slice.title,
    command: { ...pending, targetSliceIndex: index },
    supersededCommandId: null,
  };
}

function taskProjection(state: TaskState): Pick<WorkflowState, "status" | "nextAction"> {
  switch (state) {
    case "CREATED": case "CLASSIFYING": case "DISCOVERING": case "PLANNING": return { status: "planning", nextAction: "plan" };
    case "AWAITING_APPROVAL": return { status: "awaiting_approval", nextAction: "await_approval" };
    case "IMPLEMENTING": return { status: "running", nextAction: "implement" };
    case "VERIFYING": return { status: "verifying", nextAction: "verify" };
    case "REVIEWING": return { status: "reviewing", nextAction: "review" };
    case "DELIVERY_READY": return { status: "awaiting_feedback", nextAction: "checkpoint" };
    case "DELIVERING": return { status: "running", nextAction: "deliver" };
    case "RECOVERY_REQUIRED": case "PAUSED": return { status: "recovery_required", nextAction: "recover" };
    case "BLOCKED": return { status: "blocked", nextAction: "recover" };
    case "FAILED": return { status: "failed", nextAction: "recover" };
    case "CANCELLED": return { status: "cancelled", nextAction: "none" };
    case "COMPLETE": return { status: "complete", nextAction: "none" };
  }
}

function taskEvent(taskId: string, type: string, payload: Record<string, unknown>, occurredAt = new Date().toISOString()): TaskEvent {
  return { id: randomUUID(), taskId, type, payload, occurredAt };
}

function command(
  projectId: string,
  workflowVersion: number,
  action: WorkflowState["nextAction"],
  now: string,
  targetSliceIndex: number | null = null,
) {
  return {
    id: `${projectId}:${workflowVersion}:${action}`,
    action,
    workflowVersion,
    createdAt: now,
    targetSliceIndex,
    claimedByTaskId: null,
    claimedAt: null,
  };
}

function pendingVerification(attempt: number) {
  return { ...inactiveVerificationGate, attempt };
}

function assertVerificationPassed(task: Task, workflow: WorkflowState, target: string) {
  if (workflow.verification.status !== "passed" || workflow.verification.attempt !== task.attempts) {
    throw new Error(`${target} requires a passed verification gate for repair attempt ${task.attempts}.`);
  }
}

export class WorkflowEngine {
  private readonly store: WorkflowStore;
  constructor(store: WorkflowStore) { this.store = store; }

  get(projectId: string): WorkflowState | null { return this.store.findWorkflow(projectId); }

  start(
    task: Task,
    intent: WorkflowIntent,
    detail = "Workflow created.",
    options: { commandId?: string | null; feedback?: string; sliceAction?: FrontendSliceAction } = {},
  ): WorkflowState {
    const existing = this.store.findWorkflow(task.projectId);
    if (intent === "project_plan" && existing?.projectPlan && existing.projectPlan.status !== "proposed") {
      throw new Error("An approved project plan is frozen; use the active project workflow instead of silently replanning it.");
    }
    if (intent === "general" && existing?.pendingCommand) {
      throw new Error(`Project workflow command ${existing.pendingCommand.id} must be consumed before unrelated project work can take ownership.`);
    }
    if (intent === "backend") {
      if (!existing?.projectPlan || existing.projectPlan.status !== "frontend_complete" || !existing.projectPlan.backendRequired) {
        throw new Error("Backend planning requires a completed frontend plan that explicitly requires backend work.");
      }
    }
    const sliceSelection = intent === "frontend_slice"
      ? selectFrontendSlice(existing, options.sliceAction, options.commandId)
      : null;

    if (intent !== "frontend_slice" && options.commandId) {
      if (existing?.pendingCommand?.id !== options.commandId) {
        if (existing?.lastConsumedCommandId === options.commandId) throw new Error(`Workflow command ${options.commandId} was already consumed.`);
        throw new Error(`Workflow command ${options.commandId} is no longer pending.`);
      }
      if (existing.pendingCommand.claimedByTaskId && existing.pendingCommand.claimedByTaskId !== task.id) {
        throw new Error(`Workflow command ${options.commandId} is already claimed by task ${existing.pendingCommand.claimedByTaskId}.`);
      }
    }

    const now = new Date().toISOString();
    const state = WorkflowStateSchema.parse({
      projectId: task.projectId,
      taskId: task.id,
      loop: loopForIntent(intent),
      phase: intent === "backend" ? "backend" : intent === "project_plan" ? "planning" : intent === "frontend_slice" ? "frontend" : existing?.phase ?? "planning",
      status: "planning",
      nextAction: "plan",
      planApprovalId: existing?.planApprovalId ?? null,
      planApproved: existing?.planApproved ?? false,
      projectPlan: existing?.projectPlan ?? null,
      planRevisionResumeIndex: existing?.planRevisionResumeIndex ?? null,
      sliceIndex: intent === "frontend_slice" ? sliceSelection!.index : intent === "backend" || intent === "general" ? null : existing?.sliceIndex ?? null,
      sliceTotal: intent === "frontend_slice" ? sliceSelection!.total : intent === "backend" || intent === "general" ? null : existing?.sliceTotal ?? null,
      sliceTitle: intent === "frontend_slice" ? sliceSelection!.title : intent === "backend" || intent === "general" ? null : existing?.sliceTitle ?? null,
      feedback: options.feedback?.trim() ? [...(existing?.feedback ?? []), options.feedback.trim().slice(0, 4000)] : existing?.feedback ?? [],
      handoff: existing?.handoff ?? null,
      pendingCommand: sliceSelection?.command
        ? { ...sliceSelection.command, claimedByTaskId: task.id, claimedAt: now }
        : intent === "frontend_slice"
          ? null
          : options.commandId && existing?.pendingCommand
            ? { ...existing.pendingCommand, claimedByTaskId: task.id, claimedAt: now }
            : null,
      lastConsumedCommandId: sliceSelection?.supersededCommandId ?? existing?.lastConsumedCommandId ?? null,
      verification: pendingVerification(0),
      recovery: inactiveWorkflowRecovery,
      attemptPhase: null,
      designRefinementAttempt: 0,
      repairAttempt: 0,
      recoveryCategory: null,
      detail,
      version: (existing?.version ?? 0) + 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    this.store.commitWorkflowMutation({
      task,
      state,
      events: [taskEvent(task.id, "TASK_CREATED", {
        state: task.state,
        workflowVersion: state.version,
        loop: state.loop,
        sliceAction: options.sliceAction ?? null,
        sliceIndex: state.sliceIndex,
        claimedCommandId: sliceSelection?.command?.id ?? options.commandId ?? null,
        supersededCommandId: sliceSelection?.supersededCommandId ?? null,
      }, now)],
    });
    return state;
  }

  startFrontendSlice(
    task: Task,
    action: FrontendSliceAction,
    detail = "Starting the selected frontend slice mini-loop.",
    options: { commandId?: string | null; feedback?: string } = {},
  ): WorkflowState {
    return this.start(task, "frontend_slice", detail, { ...options, sliceAction: action });
  }

  beginPlanRevision(task: Task, reason: string): { task: Task; workflow: WorkflowState } {
    if (task.state !== "RECOVERY_REQUIRED") throw new Error("Plan revision requires a recovery-required task.");
    assertTransition(task.state, "PLANNING");
    const current = this.requireTask(task);
    if (current.recovery.category !== "plan_repair_required") throw new Error("Plan revision requires a plan_repair_required recovery.");
    if (!current.projectPlan || current.projectPlan.status !== "approved") throw new Error("Plan revision requires an approved project plan.");
    if (current.sliceIndex === null) throw new Error("Plan revision requires an active frontend slice.");
    const now = new Date().toISOString();
    const updatedTask = { ...task, state: "PLANNING" as const, updatedAt: now };
    const workflow = WorkflowStateSchema.parse({
      ...current,
      taskId: task.id,
      loop: "project",
      phase: "planning",
      status: "planning",
      nextAction: "plan",
      planApproved: false,
      planRevisionResumeIndex: current.sliceIndex,
      pendingCommand: null,
      recovery: {
        ...current.recovery,
        status: "repairing",
        resumeAction: "replan",
        reason: reason.trim().slice(0, 4_000),
        updatedAt: now,
      },
      detail: reason.trim().slice(0, 4_000),
      version: current.version + 1,
      updatedAt: now,
    });
    this.store.commitWorkflowMutation({
      task: updatedTask,
      state: workflow,
      events: [
        taskEvent(task.id, "PLAN_REVISION_STARTED", {
          baseRevision: current.projectPlan.revision,
          resumeSliceIndex: current.sliceIndex,
          reason: workflow.detail,
          workflowVersion: workflow.version,
        }, now),
        taskEvent(task.id, "TASK_STATE_CHANGED", { from: task.state, to: "PLANNING", workflowVersion: workflow.version }, now),
      ],
    });
    return { task: updatedTask, workflow };
  }

  setProjectPlan(task: Task, plan: WorkflowProjectPlan): WorkflowState {
    const current = this.requireTask(task);
    if (current.loop !== "project" || current.phase !== "planning") throw new Error("Only the outer project planning loop may replace the project plan.");
    const proposedPlan = {
      ...plan,
      revision: current.projectPlan ? current.projectPlan.revision + 1 : 1,
      status: "proposed" as const,
      approvedAt: null,
    };
    const previousResumeIndex = current.planRevisionResumeIndex;
    const previousSliceId = previousResumeIndex !== null ? current.projectPlan?.slices[previousResumeIndex]?.id ?? null : null;
    const matchedResumeIndex = previousSliceId ? proposedPlan.slices.findIndex((slice) => slice.id === previousSliceId) : -1;
    const resumeIndex = previousResumeIndex === null
      ? null
      : matchedResumeIndex >= 0
        ? matchedResumeIndex
        : Math.min(previousResumeIndex, Math.max(0, proposedPlan.slices.length - 1));
    return this.update(task, current, {
      projectPlan: proposedPlan,
      planRevisionResumeIndex: resumeIndex,
      sliceIndex: resumeIndex,
      sliceTotal: proposedPlan.slices.length,
      sliceTitle: resumeIndex === null ? null : proposedPlan.slices[resumeIndex]?.title ?? null,
      planApproved: false,
      pendingCommand: null,
      detail: `Frontend phase plan revision ${proposedPlan.revision} is persisted in SQLite.`,
    }, "PROJECT_PLAN_SNAPSHOT_UPDATED", {
      revision: proposedPlan.revision,
      status: proposedPlan.status,
      sliceTotal: proposedPlan.slices.length,
      resumeSliceIndex: resumeIndex,
    });
  }

  setHandoff(task: Task, handoff: string): WorkflowState {
    const current = this.requireTask(task);
    return this.update(task, current, { handoff: handoff.trim().slice(0, 20_000) }, "WORKFLOW_HANDOFF_UPDATED", {});
  }

  transition(task: Task, to: TaskState): { task: Task; workflow: WorkflowState; event: TaskEvent } {
    assertTransition(task.state, to);
    const current = this.requireTask(task);
    if (to === "REVIEWING" || to === "DELIVERY_READY") assertVerificationPassed(task, current, to);
    const now = new Date().toISOString();
    const updatedTask = { ...task, state: to, updatedAt: now };
    const interruptedCommand = to === "RECOVERY_REQUIRED" && current.pendingCommand?.claimedByTaskId === task.id
      ? current.pendingCommand
      : null;
    const workflow = WorkflowStateSchema.parse({
      ...current,
      ...taskProjection(to),
      pendingCommand: interruptedCommand
        ? { ...interruptedCommand, claimedByTaskId: null, claimedAt: null }
        : current.pendingCommand,
      verification: to === "VERIFYING" || to === "IMPLEMENTING" ? pendingVerification(updatedTask.attempts) : current.verification,
      attemptPhase: to === "IMPLEMENTING" ? (current.attemptPhase ?? "implementation") : null,
      recovery: to === "RECOVERY_REQUIRED"
        ? {
            status: "required",
            category: current.recoveryCategory ?? "interrupted",
            previousTaskState: task.state,
            checkpointId: current.recovery.checkpointId,
            resumeAction: "inspect_worktree",
            reason: "The active workflow was interrupted and requires inspection before mutation resumes.",
            updatedAt: now,
          }
        : current.recovery,
      repairAttempt: updatedTask.attempts,
      detail: `Task moved from ${task.state} to ${to}.`,
      version: current.version + 1,
      updatedAt: now,
    });
    const event = taskEvent(task.id, "TASK_STATE_CHANGED", {
      from: task.state,
      to,
      workflowVersion: workflow.version,
      releasedCommandId: interruptedCommand?.id ?? null,
    }, now);
    this.store.commitWorkflowMutation({ task: updatedTask, state: workflow, events: [event] });
    return { task: updatedTask, workflow, event };
  }

  requestApproval(task: Task, approval: Approval, kind: "project_plan" | "project_plan_revision" | "execution"): { task: Task; workflow: WorkflowState } {
    assertTransition(task.state, "AWAITING_APPROVAL");
    const current = this.requireTask(task);
    const now = new Date().toISOString();
    const updatedTask = { ...task, state: "AWAITING_APPROVAL" as const, updatedAt: now };
    const claimedCommand = current.pendingCommand?.claimedByTaskId === task.id ? current.pendingCommand : null;
    const workflow = WorkflowStateSchema.parse({
      ...current,
      planApprovalId: kind === "project_plan" || kind === "project_plan_revision" ? approval.id : current.planApprovalId,
      status: "awaiting_approval",
      nextAction: "await_approval",
      pendingCommand: claimedCommand ? null : current.pendingCommand,
      lastConsumedCommandId: claimedCommand?.id ?? current.lastConsumedCommandId,
      detail: kind === "project_plan"
        ? "Project plan is awaiting operator approval."
        : kind === "project_plan_revision"
          ? "Project plan revision is awaiting operator approval before the current worktree can resume."
          : "Execution is awaiting operator approval.",
      version: current.version + 1,
      updatedAt: now,
    });
    this.store.commitWorkflowMutation({
      task: updatedTask,
      approval,
      state: workflow,
      events: [
        taskEvent(task.id, "APPROVAL_REQUESTED", { approvalId: approval.id, kind, workflowVersion: workflow.version, consumedCommandId: claimedCommand?.id ?? null }, now),
        taskEvent(task.id, "TASK_STATE_CHANGED", { from: task.state, to: "AWAITING_APPROVAL", workflowVersion: workflow.version }, now),
      ],
    });
    return { task: updatedTask, workflow };
  }

  decideApproval(task: Task, approval: Approval, kind: "project_plan" | "project_plan_revision" | "execution"): { task: Task; workflow: WorkflowState } {
    if (approval.status === "REQUESTED") throw new Error("Approval decision must be APPROVED or REJECTED.");
    const planRevision = kind === "project_plan_revision";
    const projectPlanDecision = kind === "project_plan" || planRevision;
    const target: TaskState = approval.status === "REJECTED"
      ? "CANCELLED"
      : kind === "project_plan"
        ? "COMPLETE"
        : "IMPLEMENTING";
    assertTransition(task.state, target);
    const current = this.requireTask(task);
    const now = new Date().toISOString();
    const updatedTask = { ...task, state: target, updatedAt: now };
    const nextVersion = current.version + 1;
    const approvedPlan = projectPlanDecision && approval.status === "APPROVED" && current.projectPlan
      ? { ...current.projectPlan, status: "approved" as const, approvedAt: approval.decidedAt ?? now }
      : current.projectPlan;
    const resumeIndex = planRevision
      ? Math.max(0, Math.min(current.planRevisionResumeIndex ?? current.sliceIndex ?? 0, Math.max(0, (approvedPlan?.slices.length ?? 1) - 1)))
      : 0;
    const activeSlice = approvedPlan?.slices[resumeIndex] ?? null;
    const projectPlanApproved = kind === "project_plan" && approval.status === "APPROVED";
    const planRevisionApproved = planRevision && approval.status === "APPROVED";
    const workflow = WorkflowStateSchema.parse({
      ...current,
      loop: planRevisionApproved ? "slice" : current.loop,
      planApproved: projectPlanDecision && approval.status === "APPROVED" ? true : current.planApproved,
      projectPlan: approvedPlan,
      planRevisionResumeIndex: planRevisionApproved ? null : current.planRevisionResumeIndex,
      phase: projectPlanApproved || planRevisionApproved ? "frontend" : current.phase,
      sliceIndex: projectPlanApproved || planRevisionApproved ? resumeIndex : current.sliceIndex,
      sliceTotal: projectPlanApproved || planRevisionApproved ? approvedPlan?.slices.length ?? current.sliceTotal : current.sliceTotal,
      sliceTitle: projectPlanApproved || planRevisionApproved ? activeSlice?.title ?? null : current.sliceTitle,
      status: approval.status === "REJECTED" ? "cancelled" : projectPlanApproved ? "idle" : "running",
      nextAction: approval.status === "REJECTED" ? "none" : projectPlanApproved ? "start_slice" : "implement",
      pendingCommand: projectPlanApproved ? command(task.projectId, nextVersion, "start_slice", now, 0) : null,
      verification: planRevisionApproved ? pendingVerification(updatedTask.attempts) : current.verification,
      recovery: planRevisionApproved ? inactiveWorkflowRecovery : current.recovery,
      attemptPhase: approval.status === "APPROVED" && (kind === "execution" || planRevision) ? "implementation" : current.attemptPhase,
      designRefinementAttempt: planRevisionApproved ? 0 : current.designRefinementAttempt,
      recoveryCategory: planRevisionApproved ? null : current.recoveryCategory,
      detail: approval.status === "REJECTED"
        ? "Approval was rejected."
        : projectPlanApproved
          ? "Project plan approved; Core durably scheduled the first slice."
          : planRevisionApproved
            ? `Project plan revision approved; resuming slice ${resumeIndex + 1} in the existing worktree.`
            : "Execution approved in the isolated worktree.",
      version: nextVersion,
      updatedAt: now,
    });
    const decisionEvent = approval.status === "REJECTED"
      ? (kind === "project_plan" ? "PROJECT_PLAN_REVISION_REQUESTED" : planRevision ? "PROJECT_PLAN_REVISION_REJECTED" : "APPROVAL_REJECTED")
      : (kind === "project_plan" ? "PROJECT_PLAN_APPROVED" : planRevision ? "PROJECT_PLAN_REVISION_APPROVED" : "APPROVAL_APPROVED");
    this.store.commitWorkflowMutation({
      task: updatedTask,
      approval,
      state: workflow,
      events: [
        taskEvent(task.id, decisionEvent, {
          approvalId: approval.id,
          worktreePath: approval.worktreePath,
          baseCommit: approval.baseCommit,
          revision: approvedPlan?.revision ?? null,
          resumeSliceIndex: planRevision ? resumeIndex : null,
          workflowVersion: workflow.version,
          pendingCommandId: workflow.pendingCommand?.id ?? null,
        }, now),
        taskEvent(task.id, "TASK_STATE_CHANGED", { from: task.state, to: target, workflowVersion: workflow.version }, now),
      ],
    });
    return { task: updatedTask, workflow };
  }

  activateSlice(task: Task, handoff?: string): WorkflowState {
    const current = this.requireTask(task);
    if (current.loop !== "slice" || current.phase !== "frontend") throw new Error("Only the frontend slice mini-loop may activate a slice.");
    if (!current.planApproved || !current.projectPlan || current.projectPlan.status === "proposed") throw new Error("An approved project plan is required before slice activation.");
    if (current.sliceIndex === null) throw new Error("Core has not selected a frontend slice.");
    const slice = current.projectPlan.slices[current.sliceIndex];
    if (!slice) throw new Error(`Frontend slice ${current.sliceIndex + 1} is outside the approved plan.`);
    return this.update(task, current, {
      sliceTotal: current.projectPlan.slices.length,
      sliceTitle: slice.title,
      handoff: handoff?.trim().slice(0, 20_000) ?? current.handoff,
      status: "running",
      nextAction: "implement",
      detail: `Slice ${current.sliceIndex + 1} is active inside the bounded slice mini-loop.`,
    }, "WORKFLOW_SLICE_ACTIVATED", {
      index: current.sliceIndex,
      total: current.projectPlan.slices.length,
      title: slice.title,
    });
  }

  recordVerification(task: Task, input: VerificationRecordInput): WorkflowState {
    if (task.state !== "VERIFYING") throw new Error("Verification results may be recorded only while the task is VERIFYING.");
    if (input.attempt !== task.attempts) {
      throw new Error(`Verification attempt ${input.attempt} does not match task repair attempt ${task.attempts}.`);
    }
    const current = this.requireTask(task);
    const now = new Date().toISOString();
    const gate = {
      status: input.passed ? "passed" as const : "failed" as const,
      attempt: input.attempt,
      profile: input.profile?.trim() || null,
      summary: input.summary.trim().slice(0, 4_000),
      browserPassed: input.browserPassed ?? null,
      specialistPassed: input.specialistPassed ?? null,
      resultSha256: input.resultSha256 ?? null,
      completedAt: now,
    };
    const state = WorkflowStateSchema.parse({
      ...current,
      verification: gate,
      recovery: input.passed ? inactiveWorkflowRecovery : current.recovery,
      recoveryCategory: input.passed ? null : current.recoveryCategory,
      status: "verifying",
      nextAction: input.passed ? "quality_review" : "repair",
      detail: gate.summary || (input.passed ? "Verification passed." : "Verification failed."),
      version: current.version + 1,
      updatedAt: now,
    });
    this.store.commitWorkflowMutation({
      state,
      events: [taskEvent(task.id, "VERIFICATION_COMPLETED", {
        gate,
        verification: input.evidence ?? { passed: input.passed },
        attempt: input.attempt,
        workflowVersion: state.version,
      }, now)],
    });
    return state;
  }

  completeImplementation(task: Task): { task: Task; workflow: WorkflowState; action: "verify" } {
    const result = this.transition(task, "VERIFYING");
    return { ...result, action: "verify" };
  }

  applyExecutionFailure(
    task: Task,
    reason: string,
  ): { task: Task; workflow: WorkflowState; action: "failed" | "recover" | "block" } {
    const current = this.requireTask(task);
    if (task.state === "RECOVERY_REQUIRED") {
      return { task, workflow: current, action: "recover" };
    }
    if (task.state === "BLOCKED") {
      return { task, workflow: current, action: "block" };
    }
    if (task.state === "FAILED") {
      return { task, workflow: current, action: "failed" };
    }
    assertTransition(task.state, "FAILED");
    const now = new Date().toISOString();
    const updatedTask = { ...task, state: "FAILED" as const, updatedAt: now };
    const workflow = WorkflowStateSchema.parse({
      ...current,
      status: "failed",
      nextAction: "recover",
      pendingCommand: null,
      attemptPhase: null,
      recoveryCategory: "execution_failure",
      recovery: {
        status: "blocked",
        category: "execution_failure",
        previousTaskState: task.state,
        checkpointId: current.recovery.checkpointId,
        resumeAction: "inspect_worktree",
        reason: reason.trim().slice(0, 4_000),
        updatedAt: now,
      },
      detail: reason.trim().slice(0, 4_000),
      version: current.version + 1,
      updatedAt: now,
    });
    this.store.commitWorkflowMutation({
      task: updatedTask,
      state: workflow,
      events: [
        taskEvent(task.id, "WORKFLOW_EXECUTION_FAILED", {
          previousState: task.state,
          reason: workflow.detail,
          workflowVersion: workflow.version,
        }, now),
        taskEvent(task.id, "TASK_STATE_CHANGED", {
          from: task.state,
          to: "FAILED",
          workflowVersion: workflow.version,
        }, now),
      ],
    });
    return { task: updatedTask, workflow, action: "failed" };
  }

  applyRecoveryDecision(
    task: Task,
    decision: RecoveryDecision,
    input: { retryKind: "implementation" | "technical_repair"; eventType: "IMPLEMENTATION_RETRY_SCHEDULED" | "REPAIR_SCHEDULED" },
  ): { task: Task; workflow: WorkflowState; action: "retry" | "block" } {
    if (decision.disposition === "fatal") {
      assertTransition(task.state, "BLOCKED");
      const current = this.requireTask(task);
      const now = new Date().toISOString();
      const updatedTask = { ...task, state: "BLOCKED" as const, updatedAt: now };
      const workflow = WorkflowStateSchema.parse({
        ...current,
        status: "blocked",
        nextAction: "recover",
        pendingCommand: null,
        attemptPhase: null,
        recoveryCategory: decision.category,
        recovery: {
          status: "blocked",
          category: decision.category,
          previousTaskState: task.state,
          checkpointId: current.recovery.checkpointId,
          resumeAction: "inspect_worktree",
          reason: decision.action.trim().slice(0, 4_000),
          updatedAt: now,
        },
        detail: decision.reason.trim().slice(0, 4_000),
        version: current.version + 1,
        updatedAt: now,
      });
      this.store.commitWorkflowMutation({
        task: updatedTask,
        state: workflow,
        events: [
          taskEvent(task.id, "WORKFLOW_RECOVERY_UPDATED", {
            category: decision.category,
            detail: decision.reason,
            action: decision.action,
            fatal: true,
            workflowVersion: workflow.version,
          }, now),
          taskEvent(task.id, "TASK_STATE_CHANGED", {
            from: task.state,
            to: "BLOCKED",
            workflowVersion: workflow.version,
          }, now),
        ],
      });
      return { task: updatedTask, workflow, action: "block" };
    }
    const retried = this.retry(task, {
      reason: decision.reason,
      eventType: input.eventType,
      phase: input.retryKind,
      category: decision.category,
      action: decision.action,
    });
    return { ...retried, action: "retry" };
  }

  applyVerificationOutcome(
    task: Task,
    input: { maximumRepairAttempts: number; reason: string },
  ): { task: Task; workflow: WorkflowState; action: "quality_review" | "repair" | "block" } {
    const current = this.requireTask(task);
    if (task.state !== "VERIFYING") throw new Error("Verification outcome requires a VERIFYING task.");
    if (current.verification.status === "pending") throw new Error("Verification outcome requires a recorded verification result.");
    if (current.verification.attempt !== task.attempts) {
      throw new Error(`Verification outcome belongs to attempt ${current.verification.attempt}, not current attempt ${task.attempts}.`);
    }
    if (current.verification.status === "passed") {
      return { task, workflow: current, action: "quality_review" };
    }
    if (task.attempts >= input.maximumRepairAttempts) {
      const blocked = this.transition(task, "BLOCKED");
      return { task: blocked.task, workflow: blocked.workflow, action: "block" };
    }
    const retried = this.retry(task, {
      reason: input.reason,
      eventType: "REPAIR_SCHEDULED",
      phase: "technical_repair",
    });
    return { ...retried, action: "repair" };
  }

  applyQualityOutcome(
    task: Task,
    input:
      | { action: "pass"; reason: string; maximumRepairAttempts: number; maximumDesignRefinements: number }
      | { action: "technical_repair"; reason: string; maximumRepairAttempts: number; maximumDesignRefinements: number }
      | { action: "design_refinement"; reason: string; maximumRepairAttempts: number; maximumDesignRefinements: number }
      | { action: "replan"; reason: string; maximumRepairAttempts: number; maximumDesignRefinements: number; checkpointId: string }
      | { action: "block"; reason: string; maximumRepairAttempts: number; maximumDesignRefinements: number },
  ): { task: Task; workflow: WorkflowState; action: "review" | "repair" | "design_refinement" | "replan" | "block" } {
    const current = this.requireTask(task);
    if (task.state !== "VERIFYING") throw new Error("Quality outcome requires a VERIFYING task.");
    assertVerificationPassed(task, current, "Quality review");
    if (input.action === "pass") {
      const reviewing = this.transition(task, "REVIEWING");
      return { task: reviewing.task, workflow: reviewing.workflow, action: "review" };
    }
    if (input.action === "replan") {
      const recovery = this.markRecoveryRequired(task, {
        category: "plan_repair_required",
        checkpointId: input.checkpointId,
        resumeAction: "replan",
        reason: input.reason,
      });
      return { ...recovery, action: "replan" };
    }
    if (input.action === "block") {
      const blocked = this.transition(task, "BLOCKED");
      return { task: blocked.task, workflow: blocked.workflow, action: "block" };
    }
    if (input.action === "design_refinement") {
      if (current.designRefinementAttempt >= input.maximumDesignRefinements) {
        const blocked = this.transition(task, "BLOCKED");
        return { task: blocked.task, workflow: blocked.workflow, action: "block" };
      }
      const refinement = this.beginDesignRefinement(task, {
        reason: input.reason,
        maximum: input.maximumDesignRefinements,
      });
      return { ...refinement, action: "design_refinement" };
    }
    if (task.attempts >= input.maximumRepairAttempts) {
      const blocked = this.transition(task, "BLOCKED");
      return { task: blocked.task, workflow: blocked.workflow, action: "block" };
    }
    const repaired = this.retry(task, {
      reason: input.reason,
      eventType: "REPAIR_SCHEDULED",
      phase: "technical_repair",
    });
    return { ...repaired, action: "repair" };
  }

  applyReviewOutcome(
    task: Task,
    input: { action: "pass" | "repair" | "block"; reason: string; maximumRepairAttempts: number },
  ): { task: Task; workflow: WorkflowState; action: "delivery_ready" | "repair" | "block" } {
    const current = this.requireTask(task);
    if (task.state !== "REVIEWING") throw new Error("Review outcome requires a REVIEWING task.");
    assertVerificationPassed(task, current, "Review outcome");
    if (input.action === "pass") {
      const ready = this.transition(task, "DELIVERY_READY");
      return { task: ready.task, workflow: ready.workflow, action: "delivery_ready" };
    }
    if (input.action === "block" || task.attempts >= input.maximumRepairAttempts) {
      const blocked = this.transition(task, "BLOCKED");
      return { task: blocked.task, workflow: blocked.workflow, action: "block" };
    }
    const repaired = this.retry(task, {
      reason: input.reason,
      eventType: "REPAIR_SCHEDULED",
      phase: "technical_repair",
    });
    return { ...repaired, action: "repair" };
  }

  markRecoveryRequired(task: Task, input: {
    category: string;
    reason: string;
    checkpointId?: string | null;
    resumeAction?: WorkflowState["recovery"]["resumeAction"];
  }): { task: Task; workflow: WorkflowState } {
    assertTransition(task.state, "RECOVERY_REQUIRED");
    const current = this.requireTask(task);
    const now = new Date().toISOString();
    const updatedTask = { ...task, state: "RECOVERY_REQUIRED" as const, updatedAt: now };
    const workflow = WorkflowStateSchema.parse({
      ...current,
      status: "recovery_required",
      nextAction: "recover",
      pendingCommand: current.pendingCommand?.claimedByTaskId === task.id
        ? { ...current.pendingCommand, claimedByTaskId: null, claimedAt: null }
        : current.pendingCommand,
      recoveryCategory: input.category,
      attemptPhase: null,
      recovery: {
        status: "required",
        category: input.category,
        previousTaskState: task.state,
        checkpointId: input.checkpointId ?? null,
        resumeAction: input.resumeAction ?? "inspect_worktree",
        reason: input.reason.trim().slice(0, 4_000),
        updatedAt: now,
      },
      detail: input.reason.trim().slice(0, 4_000),
      version: current.version + 1,
      updatedAt: now,
    });
    this.store.commitWorkflowMutation({
      task: updatedTask,
      state: workflow,
      events: [taskEvent(task.id, "TASK_RECOVERY_REQUIRED", {
        category: input.category,
        checkpointId: input.checkpointId ?? null,
        previousState: task.state,
        resumeAction: workflow.recovery.resumeAction,
        reason: workflow.recovery.reason,
        workflowVersion: workflow.version,
      }, now)],
    });
    return { task: updatedTask, workflow };
  }

  private retry(task: Task, input: {
    reason: string;
    eventType: "REPAIR_SCHEDULED" | "IMPLEMENTATION_RETRY_SCHEDULED";
    phase?: "implementation" | "technical_repair";
    category?: string | null;
    action?: string | null;
  }): { task: Task; workflow: WorkflowState } {
    const current = this.requireTask(task);
    if (task.state !== "IMPLEMENTING") assertTransition(task.state, "IMPLEMENTING");
    const now = new Date().toISOString();
    const updatedTask = {
      ...task,
      state: "IMPLEMENTING" as const,
      attempts: task.attempts + 1,
      updatedAt: now,
    };
    const workflow = WorkflowStateSchema.parse({
      ...current,
      status: "running",
      nextAction: "implement",
      pendingCommand: null,
      verification: pendingVerification(updatedTask.attempts),
      attemptPhase: input.phase ?? (input.eventType === "REPAIR_SCHEDULED" ? "technical_repair" : "implementation"),
      recovery: {
        status: "repairing",
        category: input.category ?? current.recovery.category,
        previousTaskState: task.state,
        checkpointId: current.recovery.checkpointId,
        resumeAction: "retry_current_scope",
        reason: (input.action ?? input.reason).trim().slice(0, 4_000),
        updatedAt: now,
      },
      repairAttempt: updatedTask.attempts,
      recoveryCategory: input.category ?? current.recoveryCategory,
      detail: input.action ?? input.reason,
      version: current.version + 1,
      updatedAt: now,
    });
    const payload = {
      attempt: updatedTask.attempts,
      reason: input.reason,
      category: input.category ?? null,
      action: input.action ?? null,
      workflowVersion: workflow.version,
    };
    const events = [
      ...(task.state === "IMPLEMENTING" ? [] : [taskEvent(task.id, "TASK_STATE_CHANGED", { from: task.state, to: "IMPLEMENTING", workflowVersion: workflow.version }, now)]),
      taskEvent(task.id, input.eventType, payload, now),
      ...(input.category ? [taskEvent(task.id, "IMPLEMENTATION_RECOVERY_SCHEDULED", payload, now)] : []),
    ];
    this.store.commitWorkflowMutation({ task: updatedTask, state: workflow, events });
    return { task: updatedTask, workflow };
  }

  private beginDesignRefinement(task: Task, input: { reason: string; maximum: number }): { task: Task; workflow: WorkflowState } {
    const current = this.requireTask(task);
    if (current.designRefinementAttempt >= input.maximum) {
      throw new Error(`Design refinement limit reached (${current.designRefinementAttempt}/${input.maximum}).`);
    }
    if (task.state !== "IMPLEMENTING") assertTransition(task.state, "IMPLEMENTING");
    const now = new Date().toISOString();
    const updatedTask = { ...task, state: "IMPLEMENTING" as const, updatedAt: now };
    const refinement = current.designRefinementAttempt + 1;
    const workflow = WorkflowStateSchema.parse({
      ...current,
      status: "running",
      nextAction: "implement",
      pendingCommand: null,
      verification: pendingVerification(updatedTask.attempts),
      attemptPhase: "design_refinement",
      designRefinementAttempt: refinement,
      recovery: {
        status: "repairing",
        category: "design_refinement",
        previousTaskState: task.state,
        checkpointId: current.recovery.checkpointId,
        resumeAction: "retry_current_scope",
        reason: input.reason.trim().slice(0, 4_000),
        updatedAt: now,
      },
      recoveryCategory: "design_refinement",
      detail: input.reason.trim().slice(0, 4_000),
      version: current.version + 1,
      updatedAt: now,
    });
    const events = [
      ...(task.state === "IMPLEMENTING" ? [] : [taskEvent(task.id, "TASK_STATE_CHANGED", { from: task.state, to: "IMPLEMENTING", workflowVersion: workflow.version }, now)]),
      taskEvent(task.id, "DESIGN_REFINEMENT_SCHEDULED", {
        refinement,
        maximum: input.maximum,
        reason: input.reason,
        workflowVersion: workflow.version,
      }, now),
    ];
    this.store.commitWorkflowMutation({ task: updatedTask, state: workflow, events });
    return { task: updatedTask, workflow };
  }

  continueFromCheckpoint(
    task: Task,
    continuation: TaskContinuation,
    options: { checkpoint?: TaskCheckpoint; unresolvedReviewFindingIds?: string[]; resetAttempts?: boolean } = {},
  ): { task: Task; workflow: WorkflowState } {
    if (continuation.taskId !== task.id) throw new Error("Continuation does not belong to this task.");
    if (continuation.previousState !== task.state) {
      throw new Error(`Continuation expected task state ${continuation.previousState}, but task is ${task.state}.`);
    }
    if (options.checkpoint && options.checkpoint.id !== continuation.checkpointId) {
      throw new Error("Continuation checkpoint metadata does not match the requested checkpoint.");
    }
    const current = this.requireTask(task);
    const checkpointVerification = options.checkpoint?.verification ?? current.verification;
    if (
      (continuation.resultingState === "REVIEWING" || continuation.resultingState === "DELIVERY_READY")
      && checkpointVerification.status !== "passed"
    ) {
      throw new Error("Checkpoint continuation cannot restore a post-verification state without a durable passed verification gate.");
    }
    const now = new Date().toISOString();
    const updatedTask = { ...task, state: continuation.resultingState, attempts: options.resetAttempts ? 0 : task.attempts, updatedAt: now };
    const projection = taskProjection(continuation.resultingState);
    const workflow = WorkflowStateSchema.parse({
      ...current,
      ...projection,
      pendingCommand: null,
      verification: continuation.resultingState === "IMPLEMENTING" || continuation.resultingState === "VERIFYING"
        ? pendingVerification(updatedTask.attempts)
        : continuation.resultingState === "REVIEWING" || continuation.resultingState === "DELIVERY_READY"
          ? checkpointVerification
          : current.verification,
      attemptPhase: continuation.resultingState === "IMPLEMENTING"
        ? (options.checkpoint?.attemptPhase ?? current.attemptPhase ?? "technical_repair")
        : null,
      designRefinementAttempt: options.checkpoint?.designRefinementAttempt ?? current.designRefinementAttempt,
      recovery: continuation.status === "recovery_required" || continuation.resultingState === "PAUSED"
        ? {
            status: "required",
            category: current.recoveryCategory ?? "checkpoint_continuation",
            previousTaskState: continuation.previousState,
            checkpointId: continuation.checkpointId,
            resumeAction: continuation.resumeAction === "inspect_worktree" ? "inspect_worktree"
              : continuation.resumeAction === "await_approval" ? "await_approval"
                : continuation.resumeAction === "deliver" ? "deliver"
                  : continuation.resumeAction === "replan" ? "replan"
                    : "none",
            reason: continuation.detail,
            updatedAt: now,
          }
        : inactiveWorkflowRecovery,
      repairAttempt: updatedTask.attempts,
      recoveryCategory: continuation.status === "recovery_required" ? current.recoveryCategory ?? "checkpoint_continuation" : null,
      detail: continuation.detail,
      version: current.version + 1,
      updatedAt: now,
    });
    const eventType = continuation.status === "recovery_required" ? "TASK_RECOVERY_REQUIRED" : "TASK_CONTINUED";
    this.store.commitWorkflowMutation({
      task: updatedTask,
      continuation,
      state: workflow,
      events: [taskEvent(task.id, eventType, {
        continuationId: continuation.id,
        checkpointId: continuation.checkpointId,
        previousState: continuation.previousState,
        resultingState: continuation.resultingState,
        restoredMode: continuation.restoredMode,
        repositoryState: continuation.repositoryState,
        resumeAction: continuation.resumeAction,
        unresolvedReviewFindingIds: options.unresolvedReviewFindingIds ?? [],
        checkpointWorkflowVersion: options.checkpoint?.workflowVersion ?? null,
        verificationStatus: workflow.verification.status,
        workflowVersion: workflow.version,
      }, now)],
    });
    return { task: updatedTask, workflow };
  }

  beginDelivery(task: Task, input: { method: "commit" | "export"; expectedBaseCommit?: string | null }): { task: Task; workflow: WorkflowState } {
    assertTransition(task.state, "DELIVERING");
    const current = this.requireTask(task);
    assertVerificationPassed(task, current, "Delivery");
    const now = new Date().toISOString();
    const updatedTask = { ...task, state: "DELIVERING" as const, updatedAt: now };
    const workflow = WorkflowStateSchema.parse({
      ...current,
      status: "running",
      nextAction: "deliver",
      detail: `Delivery started using ${input.method}.`,
      version: current.version + 1,
      updatedAt: now,
    });
    this.store.commitWorkflowMutation({
      task: updatedTask,
      state: workflow,
      events: [
        taskEvent(task.id, "DELIVERY_STARTED", {
          method: input.method,
          expectedBaseCommit: input.expectedBaseCommit ?? null,
          workflowVersion: workflow.version,
        }, now),
        taskEvent(task.id, "TASK_STATE_CHANGED", { from: task.state, to: "DELIVERING", workflowVersion: workflow.version }, now),
      ],
    });
    return { task: updatedTask, workflow };
  }

  failDelivery(task: Task, message: string): { task: Task; workflow: WorkflowState } {
    assertTransition(task.state, "DELIVERY_READY");
    const current = this.requireTask(task);
    const now = new Date().toISOString();
    const updatedTask = { ...task, state: "DELIVERY_READY" as const, updatedAt: now };
    const workflow = WorkflowStateSchema.parse({
      ...current,
      status: "awaiting_feedback",
      nextAction: "checkpoint",
      detail: `Delivery failed: ${message}`,
      version: current.version + 1,
      updatedAt: now,
    });
    this.store.commitWorkflowMutation({
      task: updatedTask,
      state: workflow,
      events: [
        taskEvent(task.id, "DELIVERY_FAILED", { message, workflowVersion: workflow.version }, now),
        taskEvent(task.id, "TASK_STATE_CHANGED", { from: task.state, to: "DELIVERY_READY", workflowVersion: workflow.version }, now),
      ],
    });
    return { task: updatedTask, workflow };
  }

  completeDelivery(task: Task, result: unknown): { task: Task; workflow: WorkflowState } {
    assertTransition(task.state, "COMPLETE");
    const current = this.requireTask(task);
    assertVerificationPassed(task, current, "Delivery completion");
    const now = new Date().toISOString();
    const updatedTask = { ...task, state: "COMPLETE" as const, updatedAt: now };
    const frontend = current.loop === "slice" && current.phase === "frontend" && current.projectPlan && current.sliceIndex !== null;
    const last = frontend ? current.sliceIndex! + 1 >= current.projectPlan!.slices.length : false;
    const nextVersion = current.version + 1;
    const nextAction: WorkflowState["nextAction"] = frontend ? (last ? "request_feedback" : "advance_slice") : "none";
    const projectPlan = frontend && last ? { ...current.projectPlan!, status: "frontend_complete" as const } : current.projectPlan;
    const workflow = WorkflowStateSchema.parse({
      ...current,
      projectPlan,
      status: frontend ? "awaiting_feedback" : "complete",
      nextAction,
      pendingCommand: frontend && !last ? command(task.projectId, nextVersion, "advance_slice", now, current.sliceIndex! + 1) : null,
      detail: frontend
        ? (last ? "Final frontend slice delivered; operator feedback is requested." : `Slice ${current.sliceIndex! + 1} delivered; Core durably scheduled the next slice.`)
        : "Delivery completed.",
      version: nextVersion,
      updatedAt: now,
    });
    this.store.commitWorkflowMutation({
      task: updatedTask,
      state: workflow,
      events: [
        taskEvent(task.id, "DELIVERY_COMPLETED", { result, workflowVersion: workflow.version, pendingCommandId: workflow.pendingCommand?.id ?? null }, now),
        taskEvent(task.id, "TASK_STATE_CHANGED", { from: task.state, to: "COMPLETE", workflowVersion: workflow.version }, now),
      ],
    });
    return { task: updatedTask, workflow };
  }

  private requireTask(task: Task): WorkflowState {
    const existing = this.store.findWorkflow(task.projectId);
    if (!existing) {
      const now = new Date().toISOString();
      const migrated = WorkflowStateSchema.parse({
        projectId: task.projectId,
        taskId: task.id,
        loop: "general",
        phase: "planning",
        status: taskProjection(task.state).status,
        nextAction: taskProjection(task.state).nextAction,
        planApprovalId: null,
        planApproved: false,
        projectPlan: null,
        sliceIndex: null,
        sliceTotal: null,
        sliceTitle: null,
        feedback: [],
        handoff: null,
        pendingCommand: null,
        lastConsumedCommandId: null,
        verification: pendingVerification(task.attempts),
        recovery: inactiveWorkflowRecovery,
        repairAttempt: task.attempts,
        recoveryCategory: null,
        detail: "Migrated legacy task into the persistent workflow engine.",
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      this.store.commitWorkflowMutation({
        state: migrated,
        events: [taskEvent(task.id, "WORKFLOW_MIGRATED", { workflowVersion: migrated.version }, now)],
      });
      return migrated;
    }
    if (existing.taskId !== task.id) throw new Error(`Workflow ${task.projectId} is owned by task ${existing.taskId ?? "none"}, not ${task.id}.`);
    return existing;
  }

  private update(
    task: Task,
    current: WorkflowState,
    changes: Partial<WorkflowState>,
    eventType: string,
    payload: Record<string, unknown>,
  ): WorkflowState {
    const now = new Date().toISOString();
    const state = WorkflowStateSchema.parse({
      ...current,
      ...changes,
      version: current.version + 1,
      updatedAt: now,
    });
    this.store.commitWorkflowMutation({
      state,
      events: [taskEvent(task.id, eventType, { ...payload, workflowVersion: state.version }, now)],
    });
    return state;
  }
}
