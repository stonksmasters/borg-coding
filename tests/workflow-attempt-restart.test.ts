import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApproval, createTask } from "../packages/core/src/contracts.ts";
import { WorkflowEngine } from "../packages/core/src/workflow-engine.ts";
import { SqliteTaskRepository } from "../packages/persistence/src/sqlite-task-repository.ts";

function approve(engine: WorkflowEngine, id: string, projectId: string) {
  let task = createTask({ id, projectId, request: "Build safely" });
  engine.start(task, "general");
  task = engine.transition(task, "CLASSIFYING").task;
  task = engine.transition(task, "DISCOVERING").task;
  task = engine.transition(task, "PLANNING").task;
  const approval = createApproval({ id: `${id}-approval`, taskId: task.id });
  task = engine.requestApproval(task, approval, "execution").task;
  return engine.decideApproval(task, {
    ...approval,
    status: "APPROVED",
    decidedAt: new Date().toISOString(),
    worktreePath: `/tmp/${id}`,
    baseCommit: "base",
  }, "execution").task;
}

function verify(engine: WorkflowEngine, task: ReturnType<typeof createTask>, passed: boolean) {
  engine.recordVerification(task, {
    passed,
    attempt: task.attempts,
    profile: "quick",
    summary: passed ? "Verification passed." : "Verification failed.",
    browserPassed: passed,
    specialistPassed: true,
    resultSha256: (passed ? "c" : "d").repeat(64),
  });
}

test("technical repair phase survives SQLite restart", () => {
  const root = mkdtempSync(join(tmpdir(), "borg-attempt-restart-"));
  const databasePath = join(root, "borg.db");
  let repository = new SqliteTaskRepository(databasePath);
  try {
    let engine = new WorkflowEngine(repository);
    let task = approve(engine, "repair-task", "repair-project");
    task = engine.completeImplementation(task).task;
    verify(engine, task, false);
    const repair = engine.applyVerificationOutcome(task, {
      maximumRepairAttempts: 2,
      reason: "Build failed.",
    });
    assert.equal(repair.task.state, "IMPLEMENTING");
    assert.equal(repair.workflow.attemptPhase, "technical_repair");
    assert.equal(repair.task.attempts, 1);
    repository.close();

    repository = new SqliteTaskRepository(databasePath);
    engine = new WorkflowEngine(repository);
    const restoredTask = repository.findTask("repair-task");
    const restoredWorkflow = engine.get("repair-project");
    assert.equal(restoredTask?.state, "IMPLEMENTING");
    assert.equal(restoredTask?.attempts, 1);
    assert.equal(restoredWorkflow?.attemptPhase, "technical_repair");
    assert.equal(restoredWorkflow?.verification.status, "pending");
    assert.equal(restoredWorkflow?.verification.attempt, 1);
  } finally {
    repository.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("design refinement phase and counter survive SQLite restart", () => {
  const root = mkdtempSync(join(tmpdir(), "borg-design-restart-"));
  const databasePath = join(root, "borg.db");
  let repository = new SqliteTaskRepository(databasePath);
  try {
    let engine = new WorkflowEngine(repository);
    let task = approve(engine, "design-task", "design-project");
    task = engine.completeImplementation(task).task;
    verify(engine, task, true);
    const refinement = engine.applyQualityOutcome(task, {
      action: "design_refinement",
      reason: "Improve the visual hierarchy.",
      maximumRepairAttempts: 2,
      maximumDesignRefinements: 3,
    });
    assert.equal(refinement.task.state, "IMPLEMENTING");
    assert.equal(refinement.workflow.attemptPhase, "design_refinement");
    assert.equal(refinement.workflow.designRefinementAttempt, 1);
    repository.close();

    repository = new SqliteTaskRepository(databasePath);
    engine = new WorkflowEngine(repository);
    const restoredTask = repository.findTask("design-task");
    const restoredWorkflow = engine.get("design-project");
    assert.equal(restoredTask?.state, "IMPLEMENTING");
    assert.equal(restoredWorkflow?.attemptPhase, "design_refinement");
    assert.equal(restoredWorkflow?.designRefinementAttempt, 1);
  } finally {
    repository.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("verification and review durable actions survive SQLite restart", () => {
  const root = mkdtempSync(join(tmpdir(), "borg-gate-restart-"));
  const databasePath = join(root, "borg.db");
  let repository = new SqliteTaskRepository(databasePath);
  try {
    let engine = new WorkflowEngine(repository);
    let task = approve(engine, "gate-task", "gate-project");
    task = engine.completeImplementation(task).task;
    verify(engine, task, true);
    assert.equal(engine.get("gate-project")?.nextAction, "quality_review");
    repository.close();

    repository = new SqliteTaskRepository(databasePath);
    engine = new WorkflowEngine(repository);
    task = repository.findTask("gate-task")!;
    assert.equal(task.state, "VERIFYING");
    assert.equal(engine.get("gate-project")?.nextAction, "quality_review");

    const quality = engine.applyQualityOutcome(task, {
      action: "pass",
      reason: "Quality passed.",
      maximumRepairAttempts: 2,
      maximumDesignRefinements: 2,
    });
    task = quality.task;
    assert.equal(quality.workflow.nextAction, "review");
    repository.close();

    repository = new SqliteTaskRepository(databasePath);
    engine = new WorkflowEngine(repository);
    assert.equal(repository.findTask("gate-task")?.state, "REVIEWING");
    assert.equal(engine.get("gate-project")?.nextAction, "review");
  } finally {
    repository.close();
    rmSync(root, { recursive: true, force: true });
  }
});
