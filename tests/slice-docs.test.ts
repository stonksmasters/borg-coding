import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRONTEND_SLICES, markSliceReady, prepareSlice, readProjectDocs, readSliceState, slicePrompt } from "../packages/web-builder/src/slice-docs.ts";

test("frontend slices persist feedback and advance only after review", () => {
  const root = mkdtempSync(join(tmpdir(), "borg-slices-"));
  try {
    const first = prepareSlice(root, "Build a commerce app", "initial", "", "task-one");
    assert.equal(first.current, 0);
    assert.match(slicePrompt(first), /Do not create or modify backend/);
    assert.ok(readProjectDocs(root).some((doc) => doc.path.endsWith("brief.md") && doc.content.includes("commerce app")));
    assert.throws(() => prepareSlice(root, "", "advance", "Looks good", "task-two"), /not ready/);
    assert.equal(markSliceReady(root, "task-one", "Preview checked")?.status, "awaiting_feedback");
    assert.throws(() => prepareSlice(root, "", "initial", "", "task-two"), /Review the last slice/);
    const second = prepareSlice(root, "", "advance", "Looks good", "task-two");
    assert.equal(second.current, 1);
    assert.equal(readSliceState(root)?.feedback.at(-1), "Looks good");
    assert.match(readProjectDocs(root).find((doc) => doc.path.endsWith("decisions.md"))?.content ?? "", /Looks good/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("final frontend slice hands off to backend planning", () => {
  const root = mkdtempSync(join(tmpdir(), "borg-slices-"));
  try {
    let state = prepareSlice(root, "Build an app", "initial", "", "task-0");
    for (let index = 1; index < FRONTEND_SLICES.length; index += 1) {
      markSliceReady(root, `task-${index - 1}`, "Verified");
      state = prepareSlice(root, "", "advance", "Approved", `task-${index}`);
    }
    assert.equal(state.current, FRONTEND_SLICES.length - 1);
    assert.equal(markSliceReady(root, `task-${state.current}`, "Verified")?.status, "frontend_complete");
    assert.throws(() => prepareSlice(root, "", "advance", "Approved", "next"), /Frontend is complete/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
