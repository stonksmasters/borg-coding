import assert from "node:assert/strict";
import test from "node:test";
import { parseFreshReview } from "../apps/server/src/fresh-review.ts";

test("fresh review validates findings and escalates blocking severity", () => {
  const result = parseFreshReview("task-1", JSON.stringify({
    verdict: "pass", summary: "A serious issue remains.",
    findings: [{ discipline: "security", severity: "high", category: "authorization", title: "Missing check", description: "The new endpoint does not verify ownership." }],
  }));
  assert.equal(result.verdict, "repair");
  assert.deepEqual(result.criteria, []);
  assert.equal(result.findings[0].taskId, "task-1");
});

test("fresh review accepts a clean fenced JSON response", () => {
  const result = parseFreshReview("task-2", "```json\n{\"verdict\":\"pass\",\"summary\":\"Looks sound.\",\"findings\":[]}\n```");
  assert.equal(result.verdict, "pass");
  assert.deepEqual(result.criteria, []);
  assert.deepEqual(result.findings, []);
});

test("fresh review requires evidence for every supplied acceptance criterion", () => {
  const result = parseFreshReview("task-criteria", JSON.stringify({
    verdict: "pass",
    summary: "The visible criterion passed.",
    criteria: [{ criterion: "Mobile navigation works", verdict: "pass", evidence: "Browser evidence exercised the mobile menu." }],
    findings: [],
  }), ["Mobile navigation works", "Checkout button reaches the cart"]);

  assert.equal(result.verdict, "repair");
  assert.equal(result.criteria[0].verdict, "pass");
  assert.equal(result.criteria[1].verdict, "not_proven");
});
