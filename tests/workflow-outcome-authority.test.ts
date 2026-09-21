import test from "node:test";
import assert from "node:assert/strict";
import {
  createApproval,
  createTask,
  type Approval,
  type Task,
  type TaskEvent,
  type WorkflowState,
} from "../packages/core/src/contracts.ts";
import { WorkflowEngine, type WorkflowMutation, type WorkflowStore } from "../packages/core/src/workflow-engine.ts";

class MemoryWorkflowStore implements WorkflowStore {
  workflows = new Map<string, WorkflowState>();
  tasks = new Map<string, Task>();
  approvals = new Map<string, Approval>();
  events: TaskEvent[] = [];

  findWorkflow(projectId: string) { return this.workflows.get(projectId) ?? null; }
  commitWorkflowMutation(input: WorkflowMutation) {
    if (input.task) this.tasks.set(input.task.id, input.task);
    if (input.approval) this.approvals.set(input.approval.taskId, input.approval);
    if (input.events) this.events.push(...input.events);
    this.workflows.set(input.state.projectId, input.state);
  }
}

function approvedGeneral(engine: WorkflowEngine, id: string, projectId: string) {
  let task = createTask({ id, projectId, request: "Build safely" });
  engine.start(task, "general");
  task = engine.transition(task, "CLASSIFYING").task;
  task = engine.transition(task, "DISCOVERING").task;
  task = engine.transition(task, "PLANNING").task;
  const approval = createApproval({ id: `${id}-approval`, taskId: task.id });
  task = engine.requestApproval(task, approval, "execution").task;
  task = engine.decideApproval(task, {
    ...approval,
    status: "APPROVED",
    decidedAt: new Date().toISOString(),
    worktreePath: `/tmp/${id}`,
    baseCommit: "base",
  }, "execution").task;
  return task;
}

function recordVerification(engine: WorkflowEngine, task: Task, passed: boolean) {
  return engine.recordVerification(task, {
    passed,
    attempt: task.attempts,
    profile: "quick",
    summary: passed ? "Verification passed." : "Verification failed.",
    browserPassed: passed,
    specialistPassed: true,
    resultSha256: (passed ? "a" : "b").repeat(64),
  });
}

test("Core owns implementation -> verification -> quality -> review -> delivery progression", () => {
  const engine = new WorkflowEngine(new MemoryWorkflowStore());
  let task = approvedGeneral(engine, "outcome-pass", "outcome-pass-project");
  assert.equal(engine.get(task.projectId)?.attemptPhase, "implementation");

  const implementing = engine.completeImplementation(task);
  task = implementing.task;
  assert.equal(implementing.action, "verify");
  assert.equal(task.state, "VERIFYING");
  assert.equal(implementing.workflow.attemptPhase, null);
  assert.equal(implementing.workflow.nextAction, "verify");

  const gate = recordVerification(engine, task, true);
  assert.equal(gate.nextAction, "quality_review");
  const verification = engine.applyVerificationOutcome(task, {
    maximumRepairAttempts: 2,
    reason: "No failure.",
  });
  assert.equal(verification.action, "quality_review");
  assert.equal(verification.task.state, "VERIFYING");

  const quality = engine.applyQualityOutcome(task, {
    action: "pass",
    reason: "Visual/product quality passed.",
    maximumRepairAttempts: 2,
    maximumDesignRefinements: 2,
  });
  task = quality.task;
  assert.equal(quality.action, "review");
  assert.equal(task.state, "REVIEWING");
  assert.equal(quality.workflow.nextAction, "review");

  const review = engine.applyReviewOutcome(task, {
    action: "pass",
    reason: "Fresh review passed.",
    maximumRepairAttempts: 2,
  });
  assert.equal(review.action, "delivery_ready");
  assert.equal(review.task.state, "DELIVERY_READY");
  assert.equal(review.workflow.nextAction, "checkpoint");
});

test("verification repair budget and attempt phase are Core-owned", () => {
  const engine = new WorkflowEngine(new MemoryWorkflowStore());
  let task = approvedGeneral(engine, "verification-repair", "verification-repair-project");

  task = engine.completeImplementation(task).task;
  recordVerification(engine, task, false);
  const first = engine.applyVerificationOutcome(task, {
    maximumRepairAttempts: 1,
    reason: "Build failed.",
  });
  task = first.task;
  assert.equal(first.action, "repair");
  assert.equal(task.state, "IMPLEMENTING");
  assert.equal(task.attempts, 1);
  assert.equal(first.workflow.attemptPhase, "technical_repair");
  assert.equal(first.workflow.verification.status, "pending");
  assert.equal(first.workflow.verification.attempt, 1);

  task = engine.completeImplementation(task).task;
  recordVerification(engine, task, false);
  const exhausted = engine.applyVerificationOutcome(task, {
    maximumRepairAttempts: 1,
    reason: "Build still fails.",
  });
  assert.equal(exhausted.action, "block");
  assert.equal(exhausted.task.state, "BLOCKED");
  assert.equal(exhausted.workflow.status, "blocked");
});

test("design refinement counter and limit are durable Core policy", () => {
  const engine = new WorkflowEngine(new MemoryWorkflowStore());
  let task = approvedGeneral(engine, "design-refinement", "design-refinement-project");

  for (let expected = 1; expected <= 2; expected += 1) {
    task = engine.completeImplementation(task).task;
    recordVerification(engine, task, true);
    assert.equal(engine.applyVerificationOutcome(task, {
      maximumRepairAttempts: 2,
      reason: "Verification passed.",
    }).action, "quality_review");
    const refinement = engine.applyQualityOutcome(task, {
      action: "design_refinement",
      reason: `Design refinement ${expected}`,
      maximumRepairAttempts: 2,
      maximumDesignRefinements: 2,
    });
    task = refinement.task;
    assert.equal(refinement.action, "design_refinement");
    assert.equal(task.state, "IMPLEMENTING");
    assert.equal(refinement.workflow.attemptPhase, "design_refinement");
    assert.equal(refinement.workflow.designRefinementAttempt, expected);
    assert.equal(task.attempts, 0);
  }

  task = engine.completeImplementation(task).task;
  recordVerification(engine, task, true);
  const exhausted = engine.applyQualityOutcome(task, {
    action: "design_refinement",
    reason: "One refinement too many.",
    maximumRepairAttempts: 2,
    maximumDesignRefinements: 2,
  });
  assert.equal(exhausted.action, "block");
  assert.equal(exhausted.task.state, "BLOCKED");
  assert.equal(exhausted.workflow.designRefinementAttempt, 2);
});

test("fresh review repair and explicit blocking are Core-owned", () => {
  const engine = new WorkflowEngine(new MemoryWorkflowStore());
  let task = approvedGeneral(engine, "review-outcome", "review-outcome-project");
  task = engine.completeImplementation(task).task;
  recordVerification(engine, task, true);
  task = engine.applyQualityOutcome(task, {
    action: "pass",
    reason: "Quality passed.",
    maximumRepairAttempts: 2,
    maximumDesignRefinements: 2,
  }).task;

  const repair = engine.applyReviewOutcome(task, {
    action: "repair",
    reason: "Fresh review found a blocker.",
    maximumRepairAttempts: 2,
  });
  task = repair.task;
  assert.equal(repair.action, "repair");
  assert.equal(task.state, "IMPLEMENTING");
  assert.equal(task.attempts, 1);
  assert.equal(repair.workflow.attemptPhase, "technical_repair");

  task = engine.completeImplementation(task).task;
  recordVerification(engine, task, true);
  task = engine.applyQualityOutcome(task, {
    action: "pass",
    reason: "Quality passed after repair.",
    maximumRepairAttempts: 2,
    maximumDesignRefinements: 2,
  }).task;
  const blocked = engine.applyReviewOutcome(task, {
    action: "block",
    reason: "Review history still contains a blocking finding.",
    maximumRepairAttempts: 2,
  });
  assert.equal(blocked.action, "block");
  assert.equal(blocked.task.state, "BLOCKED");
  assert.equal(blocked.workflow.status, "blocked");
});


test("unexpected execution failure is a durable Core outcome", () => {
  const engine = new WorkflowEngine(new MemoryWorkflowStore());
  const task = approvedGeneral(engine, "unexpected-failure", "unexpected-failure-project");
  const failed = engine.applyExecutionFailure(task, "Unexpected orchestrator failure.");

  assert.equal(failed.action, "failed");
  assert.equal(failed.task.state, "FAILED");
  assert.equal(failed.workflow.status, "failed");
  assert.equal(failed.workflow.nextAction, "recover");
  assert.equal(failed.workflow.attemptPhase, null);
  assert.equal(failed.workflow.recovery.status, "blocked");
  assert.equal(failed.workflow.recovery.category, "execution_failure");
  assert.equal(failed.workflow.recovery.previousTaskState, "IMPLEMENTING");
  assert.match(failed.workflow.recovery.reason, /unexpected orchestrator failure/i);
});
