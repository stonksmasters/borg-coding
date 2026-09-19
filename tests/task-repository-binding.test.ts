import assert from "node:assert/strict";
import test from "node:test";
import type { TaskEvent } from "../packages/core/src/contracts.ts";
import { taskRepositoryPath } from "../packages/core/src/task-repository-binding.ts";

function event(id: string, type: string, repositoryPath: string): TaskEvent {
  return {
    id,
    taskId: "task-1",
    type,
    payload: { repositoryPath },
    occurredAt: "2026-09-19T12:00:00.000Z",
  };
}

test("task repository binding uses the first durable binding and ignores later global changes", () => {
  const events = [
    event("one", "TASK_REPOSITORY_BOUND", "C:\\Code\\repo-a"),
    event("two", "TASK_REPOSITORY_BOUND", "C:\\Code\\repo-b"),
  ];
  assert.equal(taskRepositoryPath(events), "C:\\Code\\repo-a");
});

test("legacy website repository selection remains readable for existing tasks", () => {
  assert.equal(
    taskRepositoryPath([event("legacy", "WEBSITE_REPOSITORY_SELECTED", "C:\\Code\\legacy-site")]),
    "C:\\Code\\legacy-site",
  );
  assert.equal(taskRepositoryPath([]), null);
});
