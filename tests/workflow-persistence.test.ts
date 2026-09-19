import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTask } from "../packages/core/src/contracts.ts";
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
