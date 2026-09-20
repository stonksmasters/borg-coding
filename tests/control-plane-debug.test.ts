import assert from "node:assert/strict";
import test from "node:test";
import { createApproval, createTask, WorkflowStateSchema } from "../packages/core/src/contracts.ts";
import { evaluateDebugInvariants, redactDebugValue } from "../packages/core/src/control-plane-debug.ts";

function workflow(taskId: string, projectId: string) {
  const now = new Date().toISOString();
  return WorkflowStateSchema.parse({
    projectId,
    taskId,
    loop: "slice",
    phase: "frontend",
    status: "running",
    nextAction: "implement",
    planApprovalId: null,
    planApproved: true,
    projectPlan: null,
    sliceIndex: 0,
    sliceTotal: 1,
    sliceTitle: "Hero",
    feedback: [],
    handoff: null,
    pendingCommand: null,
    lastConsumedCommandId: null,
    verification: {
      status: "pending",
      attempt: 0,
      profile: null,
      summary: "",
      browserPassed: null,
      specialistPassed: null,
      resultSha256: null,
      completedAt: null,
    },
    recovery: {
      status: "inactive",
      category: null,
      previousTaskState: null,
      checkpointId: null,
      resumeAction: "none",
      reason: "",
      updatedAt: null,
    },
    repairAttempt: 0,
    recoveryCategory: null,
    detail: "Implementing",
    version: 4,
    createdAt: now,
    updatedAt: now,
  });
}

test("debug invariants report a consistent active workflow", () => {
  const task = { ...createTask({ id: "task", projectId: "project", request: "Build" }), state: "IMPLEMENTING" as const };
  const approval = {
    ...createApproval({ id: "approval", taskId: task.id }),
    status: "APPROVED" as const,
    decidedAt: new Date().toISOString(),
    worktreePath: "/tmp/worktree",
    baseCommit: "base",
  };
  const diagnostics = evaluateDebugInvariants({
    task,
    workflow: workflow(task.id, task.projectId),
    approval,
    latestContextWorkflowVersion: 4,
    latestContextKind: "slice",
    latestContextManifestCount: 8,
    latestContextCharacters: 4000,
    latestContextBudgetCharacters: 12000,
    worktreeExists: true,
    baseCommitAncestorOfHead: true,
    activeRoleCount: 1,
    activeProcessCount: 1,
    failedProcessCount: 0,
    latestEventAt: new Date().toISOString(),
  });
  assert.deepEqual(diagnostics.map((item) => item.id), ["control_plane.consistent"]);
});

test("debug invariants catch verification, recovery, approval, ownership, and worktree contradictions", () => {
  const task = {
    ...createTask({ id: "task", projectId: "project", request: "Build" }),
    state: "RECOVERY_REQUIRED" as const,
    attempts: 2,
  };
  const state = {
    ...workflow("other-task", task.projectId),
    verification: {
      status: "passed" as const,
      attempt: 1,
      profile: "quick",
      summary: "Old verification",
      browserPassed: true,
      specialistPassed: true,
      resultSha256: "a".repeat(64),
      completedAt: new Date().toISOString(),
    },
  };
  const approval = {
    ...createApproval({ id: "approval", taskId: task.id }),
    status: "APPROVED" as const,
    decidedAt: new Date().toISOString(),
    worktreePath: "/missing",
    baseCommit: "base",
  };
  const diagnostics = evaluateDebugInvariants({
    task,
    workflow: WorkflowStateSchema.parse(state),
    approval,
    latestContextWorkflowVersion: 99,
    latestContextKind: "slice",
    latestContextManifestCount: 40,
    latestContextCharacters: 11800,
    latestContextBudgetCharacters: 12000,
    worktreeExists: false,
    baseCommitAncestorOfHead: false,
    activeRoleCount: 2,
    activeProcessCount: 0,
    failedProcessCount: 0,
    latestEventAt: new Date().toISOString(),
  });
  const ids = new Set(diagnostics.map((item) => item.id));
  assert.equal(ids.has("workflow.owner_mismatch"), true);
  assert.equal(ids.has("recovery.descriptor_missing"), true);
  assert.equal(ids.has("verification.attempt_mismatch"), true);
  assert.equal(ids.has("repository.approved_worktree_missing"), true);
  assert.equal(ids.has("context.future_workflow_version"), true);
  assert.equal(ids.has("runtime.multiple_active_roles"), true);
});

test("debug invariants reject post-verification states without a passed gate", () => {
  const task = { ...createTask({ id: "review", projectId: "project", request: "Review" }), state: "REVIEWING" as const };
  const diagnostics = evaluateDebugInvariants({
    task,
    workflow: workflow(task.id, task.projectId),
    approval: null,
    latestContextWorkflowVersion: null,
    latestContextKind: null,
    latestContextManifestCount: null,
    latestContextCharacters: null,
    latestContextBudgetCharacters: null,
    worktreeExists: null,
    baseCommitAncestorOfHead: null,
    activeRoleCount: 0,
    activeProcessCount: 0,
    failedProcessCount: 0,
    latestEventAt: new Date().toISOString(),
  });
  assert.equal(diagnostics.some((item) => item.id === "verification.required_gate_missing"), true);
});

test("debug redaction removes sensitive keys and common token formats recursively", () => {
  const value = redactDebugValue({
    authorization: "Bearer abc.def.ghi",
    nested: {
      apiKey: "super-secret-value",
      message: "token=abcdef123456 and sk-proj_abcdefghijklmnopqrstuvwxyz",
    },
    safe: "hello",
  }) as Record<string, unknown>;
  assert.equal(value.authorization, "[REDACTED]");
  assert.equal((value.nested as Record<string, unknown>).apiKey, "[REDACTED]");
  assert.doesNotMatch(String((value.nested as Record<string, unknown>).message), /abcdef123456|sk-proj_/);
  assert.equal(value.safe, "hello");
});


test("debug invariants flag an unclaimed workflow command and stalled runtime", () => {
  const now = Date.parse("2026-09-20T12:00:00.000Z");
  const task = {
    ...createTask({ id: "stalled", projectId: "project", request: "Continue" }),
    state: "IMPLEMENTING" as const,
  };
  const state = WorkflowStateSchema.parse({
    ...workflow(task.id, task.projectId),
    pendingCommand: {
      id: "cmd-1",
      action: "advance_slice",
      workflowVersion: 4,
      createdAt: "2026-09-20T11:58:00.000Z",
      targetSliceIndex: 1,
      claimedByTaskId: null,
      claimedAt: null,
    },
  });
  const diagnostics = evaluateDebugInvariants({
    task,
    workflow: state,
    approval: null,
    latestContextWorkflowVersion: 1,
    latestContextKind: "slice",
    latestContextManifestCount: 35,
    latestContextCharacters: 9600,
    latestContextBudgetCharacters: 10000,
    worktreeExists: null,
    baseCommitAncestorOfHead: null,
    activeRoleCount: 1,
    activeProcessCount: 0,
    failedProcessCount: 0,
    latestEventAt: "2026-09-20T11:50:00.000Z",
    nowMs: now,
  });
  const ids = new Set(diagnostics.map((item) => item.id));
  assert.equal(ids.has("workflow.command_unclaimed"), true);
  assert.equal(ids.has("runtime.no_progress"), true);
  assert.equal(ids.has("context.stale_workflow_version"), true);
  assert.equal(ids.has("context.scope_too_broad"), true);
  assert.equal(ids.has("context.near_budget_limit"), true);
});

test("debug invariants flag approved worktree history that no longer descends from its base", () => {
  const task = { ...createTask({ id: "git", projectId: "project", request: "Build" }), state: "IMPLEMENTING" as const };
  const approval = {
    ...createApproval({ id: "approval", taskId: task.id }),
    status: "APPROVED" as const,
    decidedAt: new Date().toISOString(),
    worktreePath: "/tmp/worktree",
    baseCommit: "base",
  };
  const diagnostics = evaluateDebugInvariants({
    task,
    workflow: workflow(task.id, task.projectId),
    approval,
    latestContextWorkflowVersion: 4,
    latestContextKind: "slice",
    latestContextManifestCount: 8,
    latestContextCharacters: 4000,
    latestContextBudgetCharacters: 12000,
    worktreeExists: true,
    baseCommitAncestorOfHead: false,
    activeRoleCount: 1,
    activeProcessCount: 1,
    failedProcessCount: 0,
    latestEventAt: new Date().toISOString(),
  });
  assert.equal(diagnostics.some((item) => item.id === "repository.base_not_ancestor"), true);
});
