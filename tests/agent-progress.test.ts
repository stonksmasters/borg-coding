import assert from "node:assert/strict";
import test from "node:test";
import { isUnsupportedLanguageTool, stageProgress, toolProgress } from "../app/agent-progress.ts";

test("planning progress explains activity without claiming a design decision before the plan exists", () => {
  assert.match(stageProgress("Discovery")!.detail, /checking/);
  assert.match(stageProgress("Plan")!.detail, /will appear in the plan/);
  assert.equal(toolProgress("repository_read"), "Reviewing the current website and its files");
  assert.equal(toolProgress("repository_read", { path: "src/style.css" }), "Reviewing the site's colors and styles");
  assert.equal(toolProgress("web_search", { query: "yellow pop musician homepage" }), "Looking up references for “yellow pop musician homepage”");
});

test("unsupported CSS language intelligence is identified as optional technical activity", () => {
  assert.equal(isUnsupportedLanguageTool("repository_diagnostics failed: Language intelligence does not support this file: src/style.css"), true);
  assert.equal(isUnsupportedLanguageTool("repository_read failed: File does not exist"), false);
});
