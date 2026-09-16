import assert from "node:assert/strict";
import test from "node:test";
import { createTask } from "../packages/core/src/contracts.ts";
import { assertTransition, canTransition } from "../packages/core/src/state-machine.ts";

test("new tasks start in CREATED", () => {
  const task = createTask({ id: "task-1", projectId: "project-1", request: "Map this repository" });
  assert.equal(task.state, "CREATED");
  assert.equal(task.riskLevel, "R1");
});

test("state machine permits the engineering path and rejects skips", () => {
  assert.equal(canTransition("CREATED", "CLASSIFYING"), true);
  assert.equal(canTransition("CREATED", "COMPLETE"), false);
  assert.throws(() => assertTransition("CREATED", "COMPLETE"), /Invalid task transition/);
  assert.equal(canTransition("VERIFYING", "IMPLEMENTING"), true);
  assert.equal(canTransition("REVIEWING", "DELIVERY_READY"), true);
  assert.equal(canTransition("DELIVERY_READY", "DELIVERING"), true);
  assert.equal(canTransition("DELIVERING", "COMPLETE"), true);
});
