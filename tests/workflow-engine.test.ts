import test from "node:test";
import assert from "node:assert/strict";
import {
  createApproval,
  createTask,
  createTaskContinuation,
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
    sitemap: [{ id: "home", name: "Home", route: "/", purpose: "Primary page", sections: ["Navigation"], componentIds: ["site-header"], acceptanceCriteria: ["Home is reachable"] }],
    components: [{ id: "site-header", name: "Site Header", kind: "layout", purpose: "Global navigation", usedBy: ["home"], variants: ["desktop", "mobile"], acceptanceCriteria: ["Navigation works"] }],
    styles: { direction: "Focused product UI", colors: [], typography: [], spacing: [], radii: [], shadows: [], layoutPrinciples: [], motion: [], responsive: [], accessibility: [], avoid: [] },
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
  task = engine.beginDelivery(task, { method: "commit", expectedBaseCommit: "abc" }).task;
  const delivered = engine.completeDelivery(task, { commit: "def" });

  assert.equal(delivered.workflow.nextAction, "advance_slice");
  assert.equal(delivered.workflow.pendingCommand?.action, "advance_slice");
  assert.equal(delivered.workflow.status, "awaiting_feedback");

  let nextTask = createTask({ id: "slice-2", projectId: "project", request: "Slice 2" });
  const started = engine.start(nextTask, "frontend_slice", "Advance", { commandId: delivered.workflow.pendingCommand!.id });
  assert.equal(started.pendingCommand?.id, delivered.workflow.pendingCommand!.id);
  assert.equal(started.pendingCommand?.claimedByTaskId, nextTask.id);
  assert.equal(started.lastConsumedCommandId, command!.id);

  // A live task owns its durable command exclusively.
  const replayTask = createTask({ id: "slice-2-replay", projectId: "project", request: "Slice 2 replay" });
  assert.throws(
    () => engine.start(replayTask, "frontend_slice", "Duplicate live launch", { commandId: delivered.workflow.pendingCommand!.id }),
    /already claimed/,
  );

  // Startup recovery releases the interrupted claim before retrying the durable command.
  nextTask = engine.transition(nextTask, "CLASSIFYING").task;
  const interrupted = engine.transition(nextTask, "RECOVERY_REQUIRED");
  assert.equal(interrupted.workflow.pendingCommand?.claimedByTaskId, null);
  assert.equal(interrupted.workflow.pendingCommand?.id, delivered.workflow.pendingCommand!.id);
  const replayed = engine.start(replayTask, "frontend_slice", "Replay after restart", { commandId: delivered.workflow.pendingCommand!.id });
  assert.equal(replayed.pendingCommand?.claimedByTaskId, replayTask.id);

  nextTask = replayTask;
  nextTask = engine.transition(nextTask, "CLASSIFYING").task;
  nextTask = engine.transition(nextTask, "DISCOVERING").task;
  nextTask = engine.transition(nextTask, "PLANNING").task;
  const nextApproval = createApproval({ id: "next-approval", taskId: nextTask.id });
  const awaiting = engine.requestApproval(nextTask, nextApproval, "execution");
  assert.equal(awaiting.workflow.pendingCommand, null);
  assert.equal(awaiting.workflow.lastConsumedCommandId, delivered.workflow.pendingCommand!.id);

  assert.throws(
    () => engine.start(createTask({ id: "duplicate", projectId: "project", request: "Duplicate" }), "frontend_slice", "Duplicate", { commandId: delivered.workflow.pendingCommand!.id }),
    /already consumed|no longer pending/,
  );
});


test("blocked task continuation preserves task identity and resets only repair attempts", () => {
  const store = new MemoryWorkflowStore();
  const engine = new WorkflowEngine(store);
  let task = createTask({ id: "slice-retry", projectId: "project-retry", request: "Repair the existing slice" });
  engine.start(task, "frontend_slice");
  task = engine.transition(task, "CLASSIFYING").task;
  task = engine.transition(task, "DISCOVERING").task;
  task = engine.transition(task, "PLANNING").task;

  const approval = createApproval({ id: "approval-retry", taskId: task.id });
  task = engine.requestApproval(task, approval, "execution").task;
  const approved = {
    ...approval,
    status: "APPROVED" as const,
    decidedAt: new Date().toISOString(),
    worktreePath: "/tmp/existing-worktree",
    baseCommit: "base",
  };
  task = engine.decideApproval(task, approved, "execution").task;
  task = engine.retry(task, { reason: "first repair", eventType: "REPAIR_SCHEDULED" }).task;
  task = engine.retry(task, { reason: "second repair", eventType: "REPAIR_SCHEDULED" }).task;
  assert.equal(task.attempts, 2);
  task = engine.transition(task, "BLOCKED").task;

  const continuation = createTaskContinuation({
    id: "continuation-retry",
    taskId: task.id,
    checkpointId: "checkpoint-retry",
    parentContinuationId: null,
    reason: "Operator requested bounded retry.",
    status: "ready",
    restoredMode: "edit",
    previousState: "BLOCKED",
    resultingState: "IMPLEMENTING",
    repositoryState: "dirty",
    resumeAction: "inspect_worktree",
    detail: "Reuse the existing approved worktree.",
    completed: true,
  });
  const resumed = engine.continueFromCheckpoint(task, continuation, { resetAttempts: true });

  assert.equal(resumed.task.id, "slice-retry");
  assert.equal(resumed.task.state, "IMPLEMENTING");
  assert.equal(resumed.task.attempts, 0);
  assert.equal(resumed.workflow.taskId, "slice-retry");
  assert.equal(resumed.workflow.repairAttempt, 0);
  assert.equal(resumed.workflow.nextAction, "implement");
  assert.ok(store.events.some((event) => event.type === "TASK_CONTINUED" && event.payload.continuationId === continuation.id));
});
