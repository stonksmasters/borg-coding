import assert from "node:assert/strict";
import test from "node:test";
import { createApproval, createTask } from "../packages/core/src/contracts.ts";
import { SqliteTaskRepository } from "../packages/persistence/src/sqlite-task-repository.ts";

test("tasks round-trip through SQLite", () => {
  const repository = new SqliteTaskRepository(":memory:");
  const task = createTask({ id: "task-1", projectId: "project-1", request: "Explain the architecture" });
  repository.saveTask(task);
  assert.deepEqual(repository.findTask(task.id), task);
  assert.deepEqual(repository.listTasks(task.projectId), [task]);
  repository.close();
});

test("approval decisions and worktree metadata round-trip through SQLite", () => {
  const repository = new SqliteTaskRepository(":memory:");
  const task = createTask({ id: "task-approval", projectId: "project-1", request: "Change the feature" });
  repository.saveTask(task);
  const requested = createApproval({ id: "approval-1", taskId: task.id });
  repository.saveApproval(requested);
  assert.deepEqual(repository.findApproval(task.id), requested);
  repository.appendEvent({ id: "event-1", taskId: task.id, type: "APPROVAL_REQUESTED", payload: { approvalId: requested.id }, occurredAt: requested.requestedAt });
  assert.equal(repository.listEvents(task.id)[0].type, "APPROVAL_REQUESTED");

  const approved = { ...requested, status: "APPROVED" as const, decidedAt: new Date().toISOString(), worktreePath: "C:\\worktrees\\task-approval", baseCommit: "a".repeat(40) };
  repository.saveApproval(approved);
  assert.deepEqual(repository.findApproval(task.id), approved);
  const finding = { id: "finding-1", taskId: task.id, discipline: "security", severity: "high" as const, category: "authorization", title: "Missing check", description: "A required ownership check is absent." };
  repository.replaceFindings(task.id, [finding]);
  assert.deepEqual(repository.listFindings(task.id), [finding]);
  repository.replaceFindings(task.id, []);
  assert.deepEqual(repository.listFindings(task.id), []);
  repository.close();
});
