import assert from "node:assert/strict";
import test from "node:test";
import { repairProgress } from "../apps/server/src/repair-progress.ts";

test("repair repetition requires both unchanged source and unchanged verification evidence", () => {
  const verification = { passed: false, results: [{ command: "npm", args: ["run", "build"], exitCode: 2, stdout: "TS2307 missing Hero" }] };
  const first = repairProgress(null, "source-a", verification);
  assert.equal(first.stalled, false);
  assert.equal(repairProgress(first, "source-a", verification).stalled, true);
  assert.equal(repairProgress(first, "source-b", verification).stalled, false);
  assert.equal(repairProgress(first, "source-a", { ...verification, results: [{ ...verification.results[0], stdout: "TS2307 missing Contact" }] }).stalled, false);
  assert.equal(repairProgress(first, "source-a", { ...verification, passed: true }).stalled, false);
});
