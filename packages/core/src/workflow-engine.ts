import { randomUUID } from "node:crypto";
import {
  WorkflowStateSchema,
  type Approval,
  type Task,
  type TaskContinuation,
  type TaskEvent,
  type TaskState,
  type WorkflowProjectPlan,
  type WorkflowState,
} from "./contracts.ts";
import { assertTransition } from "./state-machine.ts";

export type WorkflowMutation = {
  state: WorkflowState;
  task?: Task;
  approval?: Approval;
  continuation?: TaskContinuation;
  events?: TaskEvent[];
};

export interface WorkflowStore {
  findWorkflow(projectId: string): WorkflowState | null;
  saveWorkflow(state: WorkflowState): void;
  commitWorkflowMutation(input: WorkflowMutation): void;
}

export type WorkflowIntent = "project_plan" | "frontend_slice" | "backend" | "general";

function taskProjection(state: TaskState): Pick<WorkflowState, "status" | "nextAction"> {
  switch (state) {
    case "CREATED": case "CLASSIFYING": case "DISCOVERING": case "PLANNING": return { status: "planning", nextAction: "plan" };
    case "AWAITING_APPROVAL": return { status: "awaiting_approval", nextAction: "await_approval" };
    case "IMPLEMENTING": return { status: "running", nextAction: "implement" };
    case "VERIFYING": return { status: "verifying", nextAction: "verify" };
    case "REVIEWING": return { status: "reviewing", nextAction: "checkpoint" };
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

function command(projectId: string, workflowVersion: number, action: WorkflowState["nextAction"], now: string) {
  return {
    id: `${projectId}:${workflowVersion}:${action}`,
    action,
    workflowVersion,
    createdAt: now,
    claimedByTaskId: null,
    claimedAt: null,
  };
}

export class WorkflowEngine {
  private readonly store: WorkflowStore;
  constructor(store: WorkflowStore) { this.store = store; }

  get(projectId: string): WorkflowState | null { return this.store.findWorkflow(projectId); }

  start(
    task: Task,
    intent: WorkflowIntent,
    detail = "Workflow created.",
    options: { commandId?: string | null; feedback?: string } = {},
  ): WorkflowState {
    const existing = this.store.findWorkflow(task.projectId);
    if (options.commandId) {
      if (existing?.pendingCommand?.id !== options.commandId) {
        if (existing?.lastConsumedCommandId === options.commandId) throw new Error(`Workflow command ${options.commandId} was already consumed.`);
        throw new Error(`Workflow command ${options.commandId} is no longer pending.`);
      }
    }
    const now = new Date().toISOString();
    const state = WorkflowStateSchema.parse({
      projectId: task.projectId,
      taskId: task.id,
      phase: intent === "backend" ? "backend" : intent === "project_plan" ? "planning" : intent === "frontend_slice" ? "frontend" : existing?.phase ?? "planning",
      status: "planning",
      nextAction: "plan",
      planApprovalId: existing?.planApprovalId ?? null,
      planApproved: existing?.planApproved ?? false,
      projectPlan: existing?.projectPlan ?? null,
      sliceIndex: existing?.sliceIndex ?? null,
      sliceTotal: existing?.sliceTotal ?? null,
      sliceTitle: existing?.sliceTitle ?? null,
      feedback: options.feedback?.trim() ? [...(existing?.feedback ?? []), options.feedback.trim().slice(0, 4000)] : existing?.feedback ?? [],
      handoff: existing?.handoff ?? null,
      pendingCommand: options.commandId && existing?.pendingCommand
        ? { ...existing.pendingCommand, claimedByTaskId: task.id, claimedAt: now }
        : null,
      lastConsumedCommandId: existing?.lastConsumedCommandId ?? null,
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
      events: [taskEvent(task.id, "TASK_CREATED", { state: task.state, workflowVersion: state.version, consumedCommandId: options.commandId ?? null }, now)],
    });
    return state;
  }

  setProjectPlan(task: Task, plan: WorkflowProjectPlan): WorkflowState {
    const current = this.requireTask(task);
    return this.update(task, current, {
      projectPlan: plan,
      sliceTotal: plan.slices.length,
      detail: `Frontend phase plan revision ${plan.revision} is persisted in SQLite.`,
    }, "PROJECT_PLAN_SNAPSHOT_UPDATED", { revision: plan.revision, status: plan.status, sliceTotal: plan.slices.length });
  }

  setHandoff(task: Task, handoff: string): WorkflowState {
    const current = this.requireTask(task);
    return this.update(task, current, { handoff: handoff.trim().slice(0, 20_000) }, "WORKFLOW_HANDOFF_UPDATED", {});
  }

  transition(task: Task, to: TaskState): { task: Task; workflow: WorkflowState; event: TaskEvent } {
    assertTransition(task.state, to);
    const current = this.requireTask(task);
    const now = new Date().toISOString();
    const updatedTask = { ...task, state: to, updatedAt: now };
    const workflow = WorkflowStateSchema.parse({
      ...current,
      ...taskProjection(to),
      repairAttempt: updatedTask.attempts,
      detail: `Task moved from ${task.state} to ${to}.`,
      version: current.version + 1,
      updatedAt: now,
    });
    const event = taskEvent(task.id, "TASK_STATE_CHANGED", { from: task.state, to, workflowVersion: workflow.version }, now);
    this.store.commitWorkflowMutation({ task: updatedTask, state: workflow, events: [event] });
    return { task: updatedTask, workflow, event };
  }

  requestApproval(task: Task, approval: Approval, kind: "project_plan" | "execution"): { task: Task; workflow: WorkflowState } {
    assertTransition(task.state, "AWAITING_APPROVAL");
    const current = this.requireTask(task);
    const now = new Date().toISOString();
    const updatedTask = { ...task, state: "AWAITING_APPROVAL" as const, updatedAt: now };
    const claimedCommand = current.pendingCommand?.claimedByTaskId === task.id ? current.pendingCommand : null;
    const workflow = WorkflowStateSchema.parse({
      ...current,
      planApprovalId: kind === "project_plan" ? approval.id : current.planApprovalId,
      status: "awaiting_approval",
      nextAction: "await_approval",
      pendingCommand: claimedCommand ? null : current.pendingCommand,
      lastConsumedCommandId: claimedCommand?.id ?? current.lastConsumedCommandId,
      detail: kind === "project_plan" ? "Project plan is awaiting operator approval." : "Execution is awaiting operator approval.",
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

  decideApproval(task: Task, approval: Approval, kind: "project_plan" | "execution"): { task: Task; workflow: WorkflowState } {
    if (approval.status === "REQUESTED") throw new Error("Approval decision must be APPROVED or REJECTED.");
    const target: TaskState = approval.status === "REJECTED" ? "CANCELLED" : kind === "project_plan" ? "COMPLETE" : "IMPLEMENTING";
    assertTransition(task.state, target);
    const current = this.requireTask(task);
    const now = new Date().toISOString();
    const updatedTask = { ...task, state: target, updatedAt: now };
    const nextVersion = current.version + 1;
    const approvedPlan = kind === "project_plan" && approval.status === "APPROVED" && current.projectPlan
      ? { ...current.projectPlan, status: "approved" as const, approvedAt: approval.decidedAt ?? now }
      : current.projectPlan;
    const firstSlice = approvedPlan?.slices[0] ?? null;
    const projectPlanApproved = kind === "project_plan" && approval.status === "APPROVED";
    const workflow = WorkflowStateSchema.parse({
      ...current,
      planApproved: projectPlanApproved ? true : current.planApproved,
      projectPlan: approvedPlan,
      phase: projectPlanApproved ? "frontend" : current.phase,
      sliceIndex: projectPlanApproved ? 0 : current.sliceIndex,
      sliceTotal: projectPlanApproved ? approvedPlan?.slices.length ?? current.sliceTotal : current.sliceTotal,
      sliceTitle: projectPlanApproved ? firstSlice?.title ?? null : current.sliceTitle,
      status: approval.status === "REJECTED" ? "cancelled" : projectPlanApproved ? "idle" : "running",
      nextAction: approval.status === "REJECTED" ? "none" : projectPlanApproved ? "start_slice" : "implement",
      pendingCommand: projectPlanApproved ? command(task.projectId, nextVersion, "start_slice", now) : null,
      detail: approval.status === "REJECTED"
        ? "Approval was rejected."
        : projectPlanApproved
          ? "Project plan approved; Core durably scheduled the first slice."
          : "Execution approved in the isolated worktree.",
      version: nextVersion,
      updatedAt: now,
    });
    const decisionEvent = approval.status === "REJECTED"
      ? (kind === "project_plan" ? "PROJECT_PLAN_REVISION_REQUESTED" : "APPROVAL_REJECTED")
      : (kind === "project_plan" ? "PROJECT_PLAN_APPROVED" : "APPROVAL_APPROVED");
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
          workflowVersion: workflow.version,
          pendingCommandId: workflow.pendingCommand?.id ?? null,
        }, now),
        taskEvent(task.id, "TASK_STATE_CHANGED", { from: task.state, to: target, workflowVersion: workflow.version }, now),
      ],
    });
    return { task: updatedTask, workflow };
  }

  slice(task: Task, input: {
    index: number;
    total: number;
    title: string;
    status?: "running" | "awaiting_feedback" | "complete";
    handoff?: string;
  }): WorkflowState {
    const current = this.requireTask(task);
    const status = input.status ?? "running";
    const last = input.index + 1 >= input.total;
    const nextVersion = current.version + 1;
    const nextAction: WorkflowState["nextAction"] = status === "awaiting_feedback"
      ? (last ? "request_feedback" : "advance_slice")
      : status === "complete" ? "none" : "implement";
    const projectPlan = current.projectPlan && status === "awaiting_feedback" && last
      ? { ...current.projectPlan, status: "frontend_complete" as const }
      : current.projectPlan;
    return this.update(task, current, {
      phase: "frontend",
      projectPlan,
      sliceIndex: input.index,
      sliceTotal: input.total,
      sliceTitle: input.title,
      handoff: input.handoff?.trim().slice(0, 20_000) ?? current.handoff,
      status: status === "awaiting_feedback" ? "awaiting_feedback" : status === "complete" ? "complete" : "running",
      nextAction,
      pendingCommand: status === "awaiting_feedback" && !last ? command(task.projectId, nextVersion, "advance_slice", new Date().toISOString()) : null,
      detail: status === "awaiting_feedback"
        ? `Slice ${input.index + 1} is verified, delivered, and checkpointed.`
        : `Slice ${input.index + 1} is active.`,
    }, "WORKFLOW_SLICE_UPDATED", { index: input.index, total: input.total, title: input.title, status, nextAction });
  }

  retry(task: Task, input: {
    reason: string;
    eventType: "REPAIR_SCHEDULED" | "IMPLEMENTATION_RETRY_SCHEDULED";
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

  recovery(task: Task, category: string, detail: string, fatal: boolean): WorkflowState {
    const current = this.requireTask(task);
    return this.update(task, current, {
      status: fatal ? "blocked" : "recovery_required",
      nextAction: fatal ? "recover" : "repair",
      pendingCommand: null,
      recoveryCategory: category,
      detail,
      repairAttempt: task.attempts,
    }, "WORKFLOW_RECOVERY_UPDATED", { category, detail, fatal });
  }

  continueFromCheckpoint(
    task: Task,
    continuation: TaskContinuation,
    options: { unresolvedReviewFindingIds?: string[] } = {},
  ): { task: Task; workflow: WorkflowState } {
    if (continuation.taskId !== task.id) throw new Error("Continuation does not belong to this task.");
    if (continuation.previousState !== task.state) {
      throw new Error(`Continuation expected task state ${continuation.previousState}, but task is ${task.state}.`);
    }
    const current = this.requireTask(task);
    const now = new Date().toISOString();
    const updatedTask = { ...task, state: continuation.resultingState, updatedAt: now };
    const projection = taskProjection(continuation.resultingState);
    const workflow = WorkflowStateSchema.parse({
      ...current,
      ...projection,
      pendingCommand: null,
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
        workflowVersion: workflow.version,
      }, now)],
    });
    return { task: updatedTask, workflow };
  }

  beginDelivery(task: Task, input: { method: "commit" | "export"; expectedBaseCommit?: string | null }): { task: Task; workflow: WorkflowState } {
    assertTransition(task.state, "DELIVERING");
    const current = this.requireTask(task);
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
    const now = new Date().toISOString();
    const updatedTask = { ...task, state: "COMPLETE" as const, updatedAt: now };
    const frontend = current.phase === "frontend" && current.projectPlan && current.sliceIndex !== null;
    const last = frontend ? current.sliceIndex! + 1 >= current.projectPlan!.slices.length : false;
    const nextVersion = current.version + 1;
    const nextAction: WorkflowState["nextAction"] = frontend ? (last ? "request_feedback" : "advance_slice") : "none";
    const projectPlan = frontend && last ? { ...current.projectPlan!, status: "frontend_complete" as const } : current.projectPlan;
    const workflow = WorkflowStateSchema.parse({
      ...current,
      projectPlan,
      status: frontend ? "awaiting_feedback" : "complete",
      nextAction,
      pendingCommand: frontend && !last ? command(task.projectId, nextVersion, "advance_slice", now) : null,
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
        repairAttempt: task.attempts,
        recoveryCategory: null,
        detail: "Migrated legacy task into the persistent workflow engine.",
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      this.store.saveWorkflow(migrated);
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
