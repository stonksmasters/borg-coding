import assert from "node:assert/strict";
import test from "node:test";
import { normalizeActivityUpdate } from "../packages/tools/src/activity-tool.ts";

test("normalizeActivityUpdate produces bounded user-facing activity metadata", () => {
  const activity = normalizeActivityUpdate({
    phase: "editing",
    status: "progress",
    title: "  Updating   session persistence  ",
    detail: " Patching the restore path before running regression tests. ",
    files: ["src/session.ts", "src/session.ts", "tests/session.test.ts"],
  }, new Date("2026-09-18T04:00:00.000Z"));

  assert.equal(activity.phase, "editing");
  assert.equal(activity.status, "progress");
  assert.equal(activity.title, "Updating session persistence");
  assert.equal(activity.detail, "Patching the restore path before running regression tests.");
  assert.deepEqual(activity.files, ["src/session.ts", "tests/session.test.ts"]);
  assert.equal(activity.occurredAt, "2026-09-18T04:00:00.000Z");
  assert.ok(activity.id);
});

test("normalizeActivityUpdate rejects unsupported phases instead of inventing UI state", () => {
  assert.throws(() => normalizeActivityUpdate({ phase: "magic", status: "progress", title: "Nope" }), /Invalid activity phase/);
});
