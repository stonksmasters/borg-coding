import assert from "node:assert/strict";
import test from "node:test";
import { routeReasoningModel } from "../packages/orchestration/src/reasoning-router.ts";

const base = {
  mode: "edit" as const,
  intent: "quick_edit",
  impact: "local" as const,
  confidence: "high" as const,
  requiresPlanRevision: false,
  deterministicPlanAvailable: false,
};

test("reasoning routing bypasses conversational and deterministic local work", () => {
  assert.equal(routeReasoningModel({ ...base, mode: "ask", intent: "question" }).useReasoningModel, false);
  assert.equal(routeReasoningModel({ ...base, deterministicPlanAvailable: true, sourceFileCount: 1 }).useReasoningModel, false);
});

test("reasoning routing selects complex and ambiguous work", () => {
  assert.equal(routeReasoningModel({ ...base, intent: "structural_change", impact: "structural" }).useReasoningModel, true);
  assert.equal(routeReasoningModel({ ...base, intent: "backend_change", impact: "scoped" }).useReasoningModel, true);
  assert.equal(routeReasoningModel({ ...base, confidence: "medium" }).useReasoningModel, true);
  assert.equal(routeReasoningModel({ ...base, sourceFileCount: 2 }).useReasoningModel, true);
});
