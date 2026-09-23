import assert from "node:assert/strict";
import test from "node:test";
import { createTask, type TaskEvent } from "../packages/core/src/contracts.ts";
import { normalizeWorkflowEvent, normalizeWorkflowEvents } from "../packages/core/src/workflow-events.ts";

test("canonical workflow events normalize raw task telemetry into one UI contract", () => {
  const task = createTask({ id: "event-task", projectId: "event-project", request: "Build" });
  const now = new Date().toISOString();
  const events: TaskEvent[] = [
    {
      id: "state",
      taskId: task.id,
      type: "TASK_STATE_CHANGED",
      payload: { from: "IMPLEMENTING", to: "VERIFYING", workflowVersion: 7 },
      occurredAt: now,
    },
    {
      id: "verify",
      taskId: task.id,
      type: "VERIFICATION_COMPLETED",
      payload: {
        gate: { status: "passed", summary: "Full verification passed." },
        verification: { passed: true },
        workflowVersion: 8,
      },
      occurredAt: now,
    },
    {
      id: "recovery",
      taskId: task.id,
      type: "TASK_RECOVERY_REQUIRED",
      payload: { reason: "Server restarted.", workflowVersion: 9 },
      occurredAt: now,
    },
  ];

  const normalized = normalizeWorkflowEvents(task, events);
  assert.deepEqual(normalized.map((event) => event.kind), [
    "workflow.transitioned",
    "verification.completed",
    "recovery.updated",
  ]);
  assert.equal(normalized[0].projectId, task.projectId);
  assert.equal(normalized[0].workflowVersion, 7);
  assert.equal(normalized[1].status, "succeeded");
  assert.equal(normalized[1].detail, "Full verification passed.");
  assert.equal(normalized[2].category, "recovery");
  assert.match(normalized[2].detail, /Server restarted/);
});

test("tool failures retain raw provenance while using canonical tool event kind", () => {
  const task = createTask({ id: "tool-task", projectId: "event-project", request: "Build" });
  const event = normalizeWorkflowEvent(task, {
    id: "tool-failed",
    taskId: task.id,
    type: "TOOL_FAILED",
    payload: { tool: "worktree_patch", message: "Exact text did not match." },
    occurredAt: new Date().toISOString(),
  });

  assert.equal(event.kind, "tool.updated");
  assert.equal(event.category, "tool");
  assert.equal(event.status, "failed");
  assert.equal(event.sourceType, "TOOL_FAILED");
  assert.equal(event.data.tool, "worktree_patch");
});


test("render no-progress evidence is exposed as a failed review event", () => {
  const task = createTask({ id: "render-progress-task", projectId: "event-project", request: "Polish hero" });
  const event = normalizeWorkflowEvent(task, {
    id: "render-no-progress",
    taskId: task.id,
    type: "VISUAL_RENDER_NO_PROGRESS",
    payload: { reason: "Responsive screenshot fingerprint did not change.", fingerprint: "abc" },
    occurredAt: new Date().toISOString(),
  });

  assert.equal(event.kind, "review.updated");
  assert.equal(event.category, "review");
  assert.equal(event.status, "failed");
  assert.match(event.detail, /fingerprint did not change/i);
});
