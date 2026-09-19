import test from "node:test";
import assert from "node:assert/strict";
import { createApproval, createTask, type Task, type TaskEvent, type WorkflowState } from "../packages/core/src/contracts.ts";
import { WorkflowEngine, type WorkflowStore } from "../packages/core/src/workflow-engine.ts";

class MemoryWorkflowStore implements WorkflowStore {
  workflows = new Map<string, WorkflowState>();
  tasks = new Map<string, Task>();
  events: TaskEvent[] = [];
  findWorkflow(projectId: string) { return this.workflows.get(projectId) ?? null; }
  saveWorkflow(state: WorkflowState) { this.workflows.set(state.projectId, state); }
  commitWorkflowTransition(task: Task, event: TaskEvent, state: WorkflowState) {
    this.tasks.set(task.id, task); this.events.push(event); this.saveWorkflow(state);
  }
}

test("WorkflowEngine persists one authoritative project progression", () => {
  const store = new MemoryWorkflowStore();
  const engine = new WorkflowEngine(store);
  let task = createTask({ id: "task-1", projectId: "project-1", request: "Build it" });
  engine.start(task, "project_plan");
  task = engine.transition(task, "CLASSIFYING").task;
  task = engine.transition(task, "DISCOVERING").task;
  task = engine.transition(task, "PLANNING").task;
  const approval = createApproval({ id: "approval-1", taskId: task.id });
  engine.approvalRequested(task, approval, "project_plan");
  task = engine.transition(task, "AWAITING_APPROVAL").task;
  assert.equal(engine.get(task.projectId)?.nextAction, "await_approval");
  const approved = { ...approval, status: "APPROVED" as const, decidedAt: new Date().toISOString() };
  engine.approvalDecided(task, approved, "project_plan");
  assert.equal(engine.get(task.projectId)?.nextAction, "start_slice");
  assert.equal(store.events.filter((event) => event.type === "TASK_STATE_CHANGED").length, 4);
});

test("WorkflowEngine rejects a stale task from taking project ownership", () => {
  const store = new MemoryWorkflowStore();
  const engine = new WorkflowEngine(store);
  const first = createTask({ id: "first", projectId: "project", request: "First" });
  const stale = createTask({ id: "stale", projectId: "project", request: "Stale" });
  engine.start(first, "frontend_slice");
  assert.throws(() => engine.transition(stale, "CLASSIFYING"), /owned by task first/);
});

test("verified slice chooses advance or feedback from persisted state", () => {
  const store = new MemoryWorkflowStore();
  const engine = new WorkflowEngine(store);
  const task = createTask({ id: "slice", projectId: "project", request: "Slice" });
  engine.start(task, "frontend_slice");
  assert.equal(engine.slice(task, { index: 0, total: 3, title: "Hero", status: "awaiting_feedback" }).nextAction, "advance_slice");
  assert.equal(engine.slice(task, { index: 2, total: 3, title: "Contact", status: "awaiting_feedback" }).nextAction, "request_feedback");
});
