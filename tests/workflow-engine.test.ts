import test from "node:test";
import assert from "node:assert/strict";
import {
  createApproval,
  createTask,
  type Approval,
  type Task,
  type TaskEvent,
  type WorkflowProjectPlan,
  type WorkflowState,
} from "../packages/core/src/contracts.ts";
import { WorkflowEngine, type WorkflowMutation, type WorkflowStore } from "../packages/core/src/workflow-engine.ts";

class MemoryWorkflowStore implements WorkflowStore {
  workflows = new Map<string, WorkflowState>();
  tasks = new Map<string, Task>();
  approvals = new Map<string, Approval>();
  events: TaskEvent[] = [];

  findWorkflow(projectId: string) { return this.workflows.get(projectId) ?? null; }
  saveWorkflow(state: WorkflowState) { this.workflows.set(state.projectId, state); }
  commitWorkflowMutation(input: WorkflowMutation) {
    if (input.task) this.tasks.set(input.task.id, input.task);
    if (input.approval) this.approvals.set(input.approval.taskId, input.approval);
    if (input.events) this.events.push(...input.events);
    this.saveWorkflow(input.state);
  }
}

function projectPlan(): WorkflowProjectPlan {
  return {
    version: 2,
    revision: 1,
    status: "proposed",
    phase: "frontend",
    siteGoal: "Build the site",
    audience: "Operators",
    pages: ["Home"],
    features: ["Navigation"],
    visualDirection: "Focused product UI",
    backendRequired: false,
    slices: [
      { id: "hero", title: "Hero", outcome: "Hero works", scope: ["Hero"], acceptanceCriteria: ["Hero is visible"] },
      { id: "work", title: "Work", outcome: "Work works", scope: ["Work"], acceptanceCriteria: ["Work is visible"] },
    ],
    acceptanceCriteria: ["Responsive"],
    proposedAt: new Date().toISOString(),
    approvedAt: null,
  };
}

test("WorkflowEngine persists one authoritative project progression", () => {
  const store = new MemoryWorkflowStore();
  const engine = new WorkflowEngine(store);
  let task = createTask({ id: "task-1", projectId: "project-1", request: "Build it" });
  engine.start(task, "project_plan");
  task = engine.transition(task, "CLASSIFYING").task;
  task = engine.transition(task, "DISCOVERING").task;
  task = engine.transition(task, "PLANNING").task;
  engine.setProjectPlan(task, projectPlan());

  const approval = createApproval({ id: "approval-1", taskId: task.id });
  task = engine.requestApproval(task, approval, "project_plan").task;
  assert.equal(engine.get(task.projectId)?.nextAction, "await_approval");

  const approved = { ...approval, status: "APPROVED" as const, decidedAt: new Date().toISOString() };
  const decided = engine.decideApproval(task, approved, "project_plan");
  task = decided.task;
  assert.equal(task.state, "COMPLETE");
  assert.equal(decided.workflow.nextAction, "start_slice");
  assert.equal(decided.workflow.projectPlan?.status, "approved");
  assert.equal(decided.workflow.pendingCommand?.action, "start_slice");
  assert.equal(store.approvals.get(task.id)?.status, "APPROVED");
});

test("WorkflowEngine rejects a stale task from taking project ownership", () => {
  const store = new MemoryWorkflowStore();
  const engine = new WorkflowEngine(store);
  const first = createTask({ id: "first", projectId: "project", request: "First" });
  const stale = createTask({ id: "stale", projectId: "project", request: "Stale" });
  engine.start(first, "frontend_slice");
  assert.throws(() => engine.transition(stale, "CLASSIFYING"), /owned by task first/);
});

test("verified delivered slice schedules one durable advance command", () => {
  const store = new MemoryWorkflowStore();
  const engine = new WorkflowEngine(store);
  let task = createTask({ id: "plan", projectId: "project", request: "Plan" });
  engine.start(task, "project_plan");
  task = engine.transition(task, "CLASSIFYING").task;
  task = engine.transition(task, "DISCOVERING").task;
  task = engine.transition(task, "PLANNING").task;
  engine.setProjectPlan(task, projectPlan());
  const approval = createApproval({ id: "plan-approval", taskId: task.id });
  task = engine.requestApproval(task, approval, "project_plan").task;
  const approved = { ...approval, status: "APPROVED" as const, decidedAt: new Date().toISOString() };
  const planDone = engine.decideApproval(task, approved, "project_plan");
  const command = planDone.workflow.pendingCommand;
  assert.ok(command);

  task = createTask({ id: "slice-1", projectId: "project", request: "Slice 1" });
  engine.start(task, "frontend_slice", "Start slice", { commandId: command!.id });
  task = engine.transition(task, "CLASSIFYING").task;
  task = engine.transition(task, "DISCOVERING").task;
  task = engine.transition(task, "PLANNING").task;
  const sliceApproval = createApproval({ id: "slice-approval", taskId: task.id });
  task = engine.requestApproval(task, sliceApproval, "execution").task;
  const sliceApproved = { ...sliceApproval, status: "APPROVED" as const, decidedAt: new Date().toISOString(), worktreePath: "/tmp/worktree", baseCommit: "abc" };
  task = engine.decideApproval(task, sliceApproved, "execution").task;
  engine.slice(task, { index: 0, total: 2, title: "Hero", status: "running" });
  task = engine.transition(task, "VERIFYING").task;
  task = engine.transition(task, "REVIEWING").task;
  task = engine.transition(task, "DELIVERY_READY").task;
  task = engine.transition(task, "DELIVERING").task;
  const delivered = engine.completeDelivery(task, { commit: "def" });

  assert.equal(delivered.workflow.nextAction, "advance_slice");
  assert.equal(delivered.workflow.pendingCommand?.action, "advance_slice");
  assert.equal(delivered.workflow.status, "awaiting_feedback");

  const nextTask = createTask({ id: "slice-2", projectId: "project", request: "Slice 2" });
  const started = engine.start(nextTask, "frontend_slice", "Advance", { commandId: delivered.workflow.pendingCommand!.id });
  assert.equal(started.pendingCommand, null);
  assert.equal(started.lastConsumedCommandId, delivered.workflow.pendingCommand!.id);
  assert.throws(
    () => engine.start(createTask({ id: "duplicate", projectId: "project", request: "Duplicate" }), "frontend_slice", "Duplicate", { commandId: delivered.workflow.pendingCommand!.id }),
    /already consumed|no longer pending/,
  );
});
