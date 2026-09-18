import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTask, createTaskCheckpoint, createTaskContinuation } from "../packages/core/src/contracts.ts";
import { evaluateContinuation } from "../packages/core/src/continuation-policy.ts";
import { canTransition } from "../packages/core/src/state-machine.ts";
import { SqliteTaskRepository } from "../packages/persistence/src/sqlite-task-repository.ts";
import { GitWorktreeManager } from "../packages/repository/src/git-worktree-manager.ts";

function checkpoint(taskId: string, state: "AWAITING_APPROVAL" | "IMPLEMENTING" | "DELIVERY_READY", mode: "plan" | "edit" = "plan") {
  return createTaskCheckpoint({
    id: `checkpoint-${state.toLowerCase()}`,
    taskId,
    sessionId: "session-1",
    name: "Named checkpoint",
    kind: "manual",
    taskState: state,
    mode,
    repositoryPath: "C:\\repo",
    worktreePath: state === "AWAITING_APPROVAL" ? null : "C:\\worktrees\\task-1",
    baseCommit: state === "AWAITING_APPROVAL" ? null : "a".repeat(40),
    headCommit: null,
    approvalId: null,
    approvalStatus: state === "AWAITING_APPROVAL" ? "REQUESTED" : "APPROVED",
    planText: "Inspect, patch, verify.",
    contextSummary: "Planning completed.",
    completedSteps: ["PLANNING"],
    remainingSteps: ["IMPLEMENTING", "VERIFYING"],
    lastEventId: "event-1",
    activeRole: "architect",
    specialistPacks: [{ id: "backend.services", version: 1, discipline: "backend" }],
  });
}

test("named checkpoints and continuation history survive SQLite restart", () => {
  const root = mkdtempSync(join(tmpdir(), "borg-continuation-"));
  const database = join(root, "borg.db");
  try {
    const first = new SqliteTaskRepository(database);
    const task = createTask({ id: "task-1", projectId: "project-1", request: "Continue safely" });
    first.saveTask(task);
    const savedCheckpoint = checkpoint(task.id, "AWAITING_APPROVAL");
    first.saveCheckpoint(savedCheckpoint);
    const continuation = createTaskContinuation({
      id: "continuation-1",
      taskId: task.id,
      checkpointId: savedCheckpoint.id,
      parentContinuationId: null,
      reason: "Resume after restart.",
      status: "ready",
      restoredMode: "plan",
      previousState: "PAUSED",
      resultingState: "AWAITING_APPROVAL",
      repositoryState: "not_applicable",
      resumeAction: "await_approval",
      detail: "Ready for approval.",
      completed: true,
    });
    first.saveContinuation(continuation);
    first.close();

    const reopened = new SqliteTaskRepository(database);
    assert.deepEqual(reopened.findCheckpoint(savedCheckpoint.id), savedCheckpoint);
    assert.deepEqual(reopened.listCheckpoints(task.id), [savedCheckpoint]);
    assert.deepEqual(reopened.listContinuations(task.id), [continuation]);
    assert.throws(() => reopened.saveCheckpoint(savedCheckpoint), /UNIQUE/i);
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("continuation policy preserves mode authority and never replays interrupted mutation", () => {
  const planCheckpoint = checkpoint("task-plan", "AWAITING_APPROVAL", "plan");
  const planDecision = evaluateContinuation(planCheckpoint, "REQUESTED", "not_applicable");
  assert.equal(planDecision.resultingState, "AWAITING_APPROVAL");
  assert.equal(planDecision.resumeAction, "await_approval");
  assert.equal(planCheckpoint.mode, "plan");

  const alreadyApproved = evaluateContinuation(planCheckpoint, "APPROVED", "dirty", "Uncommitted changes exist.");
  assert.equal(alreadyApproved.resultingState, "RECOVERY_REQUIRED");
  assert.equal(alreadyApproved.resumeAction, "inspect_worktree");
  assert.match(alreadyApproved.detail, /do not roll back files/i);

  const editCheckpoint = checkpoint("task-edit", "IMPLEMENTING", "edit");
  const interrupted = evaluateContinuation(editCheckpoint, "APPROVED", "dirty", "Uncommitted changes exist.");
  assert.equal(interrupted.status, "recovery_required");
  assert.equal(interrupted.resultingState, "RECOVERY_REQUIRED");
  assert.equal(interrupted.resumeAction, "inspect_worktree");
  assert.match(interrupted.detail, /will not replay/i);
  assert.equal(canTransition("IMPLEMENTING", "RECOVERY_REQUIRED"), true);
});

test("worktree recovery inspection distinguishes matched, dirty, and missing state", async () => {
  const root = mkdtempSync(join(tmpdir(), "borg-worktree-recovery-"));
  const repository = join(root, "repo");
  const managed = join(root, "worktrees");
  try {
    mkdirSync(repository);
    execFileSync("git", ["init", repository]);
    execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repository, "config", "user.name", "BORG Test"]);
    writeFileSync(join(repository, "README.md"), "base\n");
    execFileSync("git", ["-C", repository, "add", "README.md"]);
    execFileSync("git", ["-C", repository, "commit", "-m", "base"]);

    const manager = new GitWorktreeManager(managed);
    const worktree = await manager.create(repository, "task-recovery");
    assert.equal((await manager.inspect(worktree.path, worktree.baseCommit)).state, "matched");
    writeFileSync(join(worktree.path, "changed.txt"), "pending\n");
    const dirty = await manager.inspect(worktree.path, worktree.baseCommit);
    assert.equal(dirty.state, "dirty");
    assert.deepEqual(dirty.changedFiles, ["changed.txt"]);
    rmSync(worktree.path, { recursive: true, force: true });
    assert.equal((await manager.inspect(worktree.path, worktree.baseCommit)).state, "missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
