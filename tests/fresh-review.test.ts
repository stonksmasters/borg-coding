import assert from "node:assert/strict";
import test from "node:test";
import { parseFreshReview } from "../apps/server/src/fresh-review.ts";

test("fresh review validates findings and escalates blocking severity", () => {
  const result = parseFreshReview("task-1", JSON.stringify({
    verdict: "pass", summary: "A serious issue remains.",
    findings: [{ discipline: "security", severity: "high", category: "authorization", title: "Missing check", description: "The new endpoint does not verify ownership." }],
  }));
  assert.equal(result.verdict, "repair");
  assert.equal(result.findings[0].taskId, "task-1");
});

test("fresh review accepts a clean fenced JSON response", () => {
  const result = parseFreshReview("task-2", "```json\n{\"verdict\":\"pass\",\"summary\":\"Looks sound.\",\"findings\":[]}\n```");
  assert.equal(result.verdict, "pass");
  assert.deepEqual(result.findings, []);
});
