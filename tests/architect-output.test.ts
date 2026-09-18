import assert from "node:assert/strict";
import test from "node:test";
import { architectRepairPrompt, validateArchitectOutput } from "../apps/server/src/architect-output.ts";

test("architect rejects raw textual tool protocol as a finished plan", () => {
  const result = validateArchitectOutput(`<function=activity_update>
<parameter=phase>
planning
</parameter>
<parameter=status>
completed
</parameter>
</function>
</tool_call>`);
  assert.equal(result.valid, false);
  assert.match(result.reason ?? "", /tool-call protocol/i);
});

test("architect accepts a real implementation plan", () => {
  const result = validateArchitectOutput("Plan the frontend in bounded vertical slices, verify each slice, and checkpoint after review.");
  assert.equal(result.valid, true);
});

test("architect repair asks for a plan without treating claimed edits as evidence", () => {
  assert.equal(validateArchitectOutput("The implementation is complete. Updated App.tsx.").valid, false);
  const correction = architectRepairPrompt("claims implementation completed");
  assert.match(correction, /No source files have been changed/);
  assert.match(correction, /read-only Architect/);
  assert.match(correction, /acceptance checks/);
});
