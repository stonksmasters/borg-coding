import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApproval, createTask, createTaskCheckpoint, createTaskContinuation } from "../packages/core/src/contracts.ts";
import { WorkflowEngine } from "../packages/core/src/workflow-engine.ts";
import { SqliteTaskRepository } from "../packages/persistence/src/sqlite-task-repository.ts";

test("workflow state and task transition commit together in SQLite", () => {
  const root = mkdtempSync(join(tmpdir(), "borg-workflow-"));
  const repository = new SqliteTaskRepository(join(root, "borg.db"));
  try {
    let task = createTask({ id: "task", projectId: "project", request: "Build" });
    repository.saveTask(task);
    const engine = new WorkflowEngine(repository);
    engine.start(task, "general");
    task = engine.transition(task, "CLASSIFYING").task;
    assert.equal(repository.findTask(task.id)?.state, "CLASSIFYING");
    assert.equal(repository.findWorkflow(task.projectId)?.taskId, task.id);
    assert.equal(repository.listEvents(task.id).at(-1)?.payload.workflowVersion, 2);
  } finally {
    repository.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("startup recovery descriptor survives SQLite restart with exact safe action", () => {
  const root = mkdtempSync(join(tmpdir(), "borg-workflow-recovery-descriptor-"));
  const databasePath = join(root, "borg.db");
  let repository = new SqliteTaskRepository(databasePath);
  try {
    let engine = new WorkflowEngine(repository);
    let task = createTask({ id: "recover-task", projectId: "recover-project", request: "Build safely" });
    repository.saveTask(task);
    engine.start(task, "general");
    task = engine.transition(task, "CLASSIFYING").task;
    task = engine.transition(task, "DISCOVERING").task;
    task = engine.transition(task, "PLANNING").task;
    const approval = createApproval({ id: "recover-approval", taskId: task.id });
    task = engine.requestApproval(task, approval, "execution").task;
    task = engine.decideApproval(task, {
      ...approval,
      status: "APPROVED",
      decidedAt: new Date().toISOString(),
      worktreePath: "/tmp/recover",
      baseCommit: "base",
    }, "execution").task;

    const recovered = engine.markRecoveryRequired(task, {
      category: "process_interrupted",
      checkpointId: "checkpoint-interrupted",
      resumeAction: "inspect_worktree",
      reason: "Server restarted during implementation.",
    });
    assert.equal(recovered.task.state, "RECOVERY_REQUIRED");
    assert.equal(recovered.workflow.recovery.previousTaskState, "IMPLEMENTING");
    repository.close();

    repository = new SqliteTaskRepository(databasePath);
    engine = new WorkflowEngine(repository);
    const restored = engine.get(task.projectId);
    assert.equal(restored?.recovery.status, "required");
    assert.equal(restored?.recovery.category, "process_interrupted");
    assert.equal(restored?.recovery.checkpointId, "checkpoint-interrupted");
    assert.equal(restored?.recovery.resumeAction, "inspect_worktree");
    assert.match(restored?.recovery.reason ?? "", /restarted during implementation/i);
    assert.equal(restored?.nextAction, "recover");
  } finally {
    repository.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkpoint continuation keeps task and workflow synchronized across restart", () => {
  const root = mkdtempSync(join(tmpdir(), "borg-workflow-continuation-"));
  const databasePath = join(root, "borg.db");
  let repository = new SqliteTaskRepository(databasePath);
  try {
    let engine = new WorkflowEngine(repository);
    let task = createTask({ id: "continuation-task", projectId: "continuation-project", request: "Build" });
    repository.saveTask(task);
    engine.start(task, "general");
    task = engine.transition(task, "CLASSIFYING").task;
    task = engine.transition(task, "DISCOVERING").task;
    task = engine.transition(task, "PLANNING").task;

    const checkpoint = createTaskCheckpoint({
      id: "planning-checkpoint",
      taskId: task.id,
      sessionId: null,
      name: "Planning checkpoint",
      kind: "manual",
      taskState: task.state,
      mode: "plan",
      repositoryPath: null,
      worktreePath: null,
      baseCommit: null,
      headCommit: null,
      approvalId: null,
      approvalStatus: null,
      planText: "Approved planning context",
      contextSummary: "Planning complete",
      completedSteps: ["Planning"],
      remainingSteps: ["Approval", "Implementation"],
      lastEventId: repository.listEvents(task.id).at(-1)?.id ?? null,
      activeRole: null,
      specialistPacks: [],
    });
    repository.saveCheckpoint(checkpoint);

    const approval = createApproval({ id: "continuation-approval", taskId: task.id });
    task = engine.requestApproval(task, approval, "execution").task;

    const continuation = createTaskContinuation({
      id: "continuation-1",
      taskId: task.id,
      checkpointId: checkpoint.id,
      parentContinuationId: null,
      reason: "Resume from the saved planning checkpoint.",
      status: "ready",
      restoredMode: "plan",
      previousState: task.state,
      resultingState: "PAUSED",
      repositoryState: "not_applicable",
      resumeAction: "replan",
      detail: "Checkpoint restored for a fresh planning continuation.",
      completed: true,
    });
    const restored = engine.continueFromCheckpoint(task, continuation, {
      unresolvedReviewFindingIds: ["finding-1"],
    });

    assert.equal(restored.task.state, "PAUSED");
    assert.equal(restored.workflow.status, "recovery_required");
    assert.equal(restored.workflow.nextAction, "recover");
    assert.equal(restored.workflow.pendingCommand, null);
    assert.equal(restored.workflow.recovery.status, "required");
    assert.equal(restored.workflow.recovery.checkpointId, checkpoint.id);
    assert.equal(restored.workflow.recovery.resumeAction, "replan");
    repository.close();

    repository = new SqliteTaskRepository(databasePath);
    engine = new WorkflowEngine(repository);
    assert.equal(repository.findTask(task.id)?.state, "PAUSED");
    assert.equal(engine.get(task.projectId)?.status, "recovery_required");
    assert.equal(engine.get(task.projectId)?.nextAction, "recover");
    assert.equal(engine.get(task.projectId)?.recovery.status, "required");
    assert.equal(engine.get(task.projectId)?.recovery.checkpointId, checkpoint.id);
    assert.equal(engine.get(task.projectId)?.recovery.resumeAction, "replan");
    assert.equal(repository.listContinuations(task.id).at(-1)?.id, continuation.id);
    const event = repository.listEvents(task.id).at(-1);
    assert.equal(event?.type, "TASK_CONTINUED");
    assert.deepEqual(event?.payload.unresolvedReviewFindingIds, ["finding-1"]);
    assert.equal(event?.payload.workflowVersion, engine.get(task.projectId)?.version);
  } finally {
    repository.close();
    rmSync(root, { recursive: true, force: true });
  }
});

