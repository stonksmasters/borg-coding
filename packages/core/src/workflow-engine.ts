import { randomUUID } from "node:crypto";
import { WorkflowStateSchema, type Approval, type Task, type TaskEvent, type TaskState, type WorkflowState } from "./contracts.ts";
import { assertTransition } from "./state-machine.ts";

export interface WorkflowStore {
  findWorkflow(projectId: string): WorkflowState | null;
  saveWorkflow(state: WorkflowState): void;
  commitWorkflowTransition(task: Task, event: TaskEvent, state: WorkflowState): void;
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

export class WorkflowEngine {
  private readonly store: WorkflowStore;
  constructor(store: WorkflowStore) { this.store = store; }

  get(projectId: string): WorkflowState | null { return this.store.findWorkflow(projectId); }

  start(task: Task, intent: WorkflowIntent, detail = "Workflow created."): WorkflowState {
    const existing = this.store.findWorkflow(task.projectId);
    const now = new Date().toISOString();
    const state = WorkflowStateSchema.parse({
      projectId: task.projectId, taskId: task.id,
      phase: intent === "backend" ? "backend" : intent === "project_plan" ? "planning" : "frontend",
      status: "planning", nextAction: "plan",
      planApprovalId: existing?.planApprovalId ?? null, planApproved: existing?.planApproved ?? false,
      sliceIndex: existing?.sliceIndex ?? null, sliceTotal: existing?.sliceTotal ?? null, sliceTitle: existing?.sliceTitle ?? null,
      repairAttempt: 0, recoveryCategory: null, detail,
      version: (existing?.version ?? 0) + 1, createdAt: existing?.createdAt ?? now, updatedAt: now,
    });
    this.store.saveWorkflow(state);
    return state;
  }

  transition(task: Task, to: TaskState): { task: Task; workflow: WorkflowState; event: TaskEvent } {
    assertTransition(task.state, to);
    const current = this.requireTask(task);
    const now = new Date().toISOString();
    const updatedTask = { ...task, state: to, updatedAt: now };
    const workflow = WorkflowStateSchema.parse({
      ...current, ...taskProjection(to), repairAttempt: updatedTask.attempts,
      detail: `Task moved from ${task.state} to ${to}.`, version: current.version + 1, updatedAt: now,
    });
    const event: TaskEvent = { id: randomUUID(), taskId: task.id, type: "TASK_STATE_CHANGED", payload: { from: task.state, to, workflowVersion: workflow.version }, occurredAt: now };
    this.store.commitWorkflowTransition(updatedTask, event, workflow);
    return { task: updatedTask, workflow, event };
  }

  approvalRequested(task: Task, approval: Approval, kind: "project_plan" | "execution"): WorkflowState {
    const current = this.requireTask(task);
    return this.update(current, { planApprovalId: kind === "project_plan" ? approval.id : current.planApprovalId, nextAction: "await_approval", status: "awaiting_approval", detail: kind === "project_plan" ? "Project plan is awaiting operator approval." : "Execution is awaiting operator approval." });
  }

  approvalDecided(task: Task, approval: Approval, kind: "project_plan" | "execution"): WorkflowState {
    const current = this.requireTask(task);
    if (approval.status === "REJECTED") return this.update(current, { status: "cancelled", nextAction: "none", detail: "Approval was rejected." });
    return this.update(current, {
      planApproved: kind === "project_plan" ? true : current.planApproved,
      phase: kind === "project_plan" ? "frontend" : current.phase,
      status: kind === "project_plan" ? "idle" : "running",
      nextAction: kind === "project_plan" ? "start_slice" : "implement",
      detail: kind === "project_plan" ? "Project plan approved; the first slice is ready to start." : "Execution approved in the isolated worktree.",
    });
  }

  slice(task: Task, input: { index: number; total: number; title: string; status?: "running" | "awaiting_feedback" | "complete" }): WorkflowState {
    const current = this.requireTask(task);
    const status = input.status ?? "running";
    const last = input.index + 1 >= input.total;
    return this.update(current, {
      phase: "frontend", sliceIndex: input.index, sliceTotal: input.total, sliceTitle: input.title,
      status: status === "awaiting_feedback" ? "awaiting_feedback" : status === "complete" ? "complete" : "running",
      nextAction: status === "awaiting_feedback" ? (last ? "request_feedback" : "advance_slice") : status === "complete" ? "none" : "implement",
      detail: status === "awaiting_feedback" ? `Slice ${input.index + 1} is verified and checkpointed.` : `Slice ${input.index + 1} is active.`,
    });
  }

  recovery(task: Task, category: string, detail: string, fatal: boolean): WorkflowState {
    const current = this.requireTask(task);
    return this.update(current, { status: fatal ? "blocked" : "recovery_required", nextAction: fatal ? "recover" : "repair", recoveryCategory: category, detail, repairAttempt: task.attempts });
  }

  private require(projectId: string, taskId?: string): WorkflowState {
    const state = this.store.findWorkflow(projectId);
    if (!state) throw new Error(`Workflow state for project ${projectId} does not exist.`);
    if (taskId && state.taskId !== taskId) throw new Error(`Workflow ${projectId} is owned by task ${state.taskId ?? "none"}, not ${taskId}.`);
    return state;
  }

  private requireTask(task: Task): WorkflowState {
    const existing = this.store.findWorkflow(task.projectId);
    if (!existing) return this.start(task, "general", "Migrated legacy task into the persistent workflow engine.");
    if (existing.taskId !== task.id) throw new Error(`Workflow ${task.projectId} is owned by task ${existing.taskId ?? "none"}, not ${task.id}.`);
    return existing;
  }

  private update(current: WorkflowState, changes: Partial<WorkflowState>): WorkflowState {
    const state = WorkflowStateSchema.parse({ ...current, ...changes, version: current.version + 1, updatedAt: new Date().toISOString() });
    this.store.saveWorkflow(state);
    return state;
  }
}
