import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createApproval,
  createTask,
  type WorkflowProjectPlan,
} from "../packages/core/src/contracts.ts";
import { WorkflowEngine } from "../packages/core/src/workflow-engine.ts";
import { SqliteTaskRepository } from "../packages/persistence/src/sqlite-task-repository.ts";

function plan(): WorkflowProjectPlan {
  return {
    version: 2,
    revision: 1,
    status: "proposed",
    phase: "frontend",
    siteGoal: "Build a complete homepage",
    audience: "Customers",
    pages: ["Home"],
    features: ["Navigation", "Portfolio", "Contact"],
    sitemap: [{ id: "home", name: "Home", route: "/", purpose: "Primary page", sections: ["Navigation"], componentIds: ["site-header"], acceptanceCriteria: ["Home is reachable"] }],
    components: [{ id: "site-header", name: "Site Header", kind: "layout", purpose: "Global navigation", usedBy: ["home"], variants: ["desktop", "mobile"], acceptanceCriteria: ["Navigation works"] }],
    styles: { direction: "Focused product UI", colors: [], typography: [], spacing: [], radii: [], shadows: [], layoutPrinciples: [], motion: [], responsive: [], accessibility: [], avoid: [] },
    visualDirection: "High-end editorial product site",
    backendRequired: false,
    slices: [
      { id: "hero", title: "Hero & Navigation", outcome: "The opening viewport works", scope: ["Hero", "Navigation"], acceptanceCriteria: ["Responsive hero", "Working navigation"] },
      { id: "content", title: "Work & Contact", outcome: "The rest of the homepage works", scope: ["Portfolio", "Contact"], acceptanceCriteria: ["Portfolio visible", "Contact usable"] },
    ],
    acceptanceCriteria: ["Responsive at mobile and desktop", "No blocking review findings"],
    proposedAt: new Date().toISOString(),
    approvedAt: null,
  };
}

function reachPlanning(engine: WorkflowEngine, id: string, projectId: string, request: string, commandId?: string) {
  let task = createTask({ id, projectId, request });
  if (commandId) {
    const pendingAction = engine.get(projectId)?.pendingCommand?.action;
    engine.startFrontendSlice(task, pendingAction === "advance_slice" ? "advance" : "initial", "Start durable slice command", { commandId });
  } else {
    engine.start(task, "project_plan", "Plan project");
  }
  task = engine.transition(task, "CLASSIFYING").task;
  task = engine.transition(task, "DISCOVERING").task;
  task = engine.transition(task, "PLANNING").task;
  return task;
}

function approveExecution(engine: WorkflowEngine, task: ReturnType<typeof createTask>, approvalId: string, index: number, total: number, title: string) {
  const requested = createApproval({ id: approvalId, taskId: task.id });
  task = engine.requestApproval(task, requested, "execution").task;
  const approved = {
    ...requested,
    status: "APPROVED" as const,
    decidedAt: new Date().toISOString(),
    worktreePath: join(tmpdir(), `borg-${task.id}`),
    baseCommit: `base-${task.id}`,
  };
  task = engine.decideApproval(task, approved, "execution").task;
  const active = engine.activateSlice(task);
  assert.equal(active.sliceIndex, index);
  assert.equal(active.sliceTotal, total);
  assert.equal(active.sliceTitle, title);
  return task;
}

function deliver(engine: WorkflowEngine, task: ReturnType<typeof createTask>, commit: string) {
  task = engine.transition(task, "VERIFYING").task;
  task = engine.transition(task, "REVIEWING").task;
  task = engine.transition(task, "DELIVERY_READY").task;
  task = engine.beginDelivery(task, { method: "commit", expectedBaseCommit: `base-${task.id}` }).task;
  return engine.completeDelivery(task, { commit });
}

test("plan approval -> slice 1 -> restart -> slice 2 -> final feedback survives SQLite restarts", () => {
  const root = mkdtempSync(join(tmpdir(), "borg-workflow-restart-"));
  const databasePath = join(root, "borg.db");
  try {
    let repository = new SqliteTaskRepository(databasePath);
    let engine = new WorkflowEngine(repository);

    let planningTask = reachPlanning(engine, "plan-task", "site", "Build the homepage");
    engine.setProjectPlan(planningTask, plan());
    const planApproval = createApproval({ id: "plan-approval", taskId: planningTask.id });
    planningTask = engine.requestApproval(planningTask, planApproval, "project_plan").task;
    const approvedPlan = { ...planApproval, status: "APPROVED" as const, decidedAt: new Date().toISOString() };
    const planned = engine.decideApproval(planningTask, approvedPlan, "project_plan");

    assert.equal(planned.workflow.pendingCommand?.action, "start_slice");
    assert.equal(planned.workflow.pendingCommand?.targetSliceIndex, 0);
    const firstCommandId = planned.workflow.pendingCommand!.id;
    repository.close();

    repository = new SqliteTaskRepository(databasePath);
    engine = new WorkflowEngine(repository);
    assert.equal(engine.get("site")?.pendingCommand?.id, firstCommandId);

    let sliceOne = reachPlanning(engine, "slice-1", "site", "Build slice 1", firstCommandId);
    sliceOne = approveExecution(engine, sliceOne, "slice-1-approval", 0, 2, "Hero & Navigation");
    const firstDelivery = deliver(engine, sliceOne, "slice-1-commit");
    const advanceCommandId = firstDelivery.workflow.pendingCommand?.id;
    assert.ok(advanceCommandId);
    assert.equal(firstDelivery.workflow.nextAction, "advance_slice");
    assert.equal(firstDelivery.workflow.pendingCommand?.targetSliceIndex, 1);
    repository.close();

    // Simulates a crash exactly after checkpoint persistence and before the gateway launches slice 2.
    repository = new SqliteTaskRepository(databasePath);
    engine = new WorkflowEngine(repository);
    const recoveredAfterDelivery = engine.get("site");
    assert.equal(recoveredAfterDelivery?.pendingCommand?.id, advanceCommandId);
    assert.equal(recoveredAfterDelivery?.pendingCommand?.targetSliceIndex, 1);
    assert.equal(recoveredAfterDelivery?.taskId, "slice-1");

    let sliceTwo = reachPlanning(engine, "slice-2", "site", "Build slice 2", advanceCommandId);
    sliceTwo = approveExecution(engine, sliceTwo, "slice-2-approval", 1, 2, "Work & Contact");
    const finalDelivery = deliver(engine, sliceTwo, "slice-2-commit");
    assert.equal(finalDelivery.workflow.nextAction, "request_feedback");
    assert.equal(finalDelivery.workflow.pendingCommand, null);
    assert.equal(finalDelivery.workflow.projectPlan?.status, "frontend_complete");
    repository.close();

    repository = new SqliteTaskRepository(databasePath);
    engine = new WorkflowEngine(repository);
    const final = engine.get("site");
    assert.equal(final?.nextAction, "request_feedback");
    assert.equal(final?.projectPlan?.status, "frontend_complete");
    assert.equal(final?.sliceIndex, 1);
    repository.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
