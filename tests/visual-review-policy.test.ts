import assert from "node:assert/strict";
import test from "node:test";
import { visualReviewStatus } from "../packages/design-intelligence/src/index.ts";

test("advisory visual polish does not create an endless repair loop", () => {
  assert.equal(visualReviewStatus({ verdict: "repair", dimensions: [{ verdict: "repair" }], findings: [{ disposition: "advisory", severity: "low" }] }), "pass");
});

test("blocking evidence overrides a model pass and severe defects cannot be advisory", () => {
  for (const finding of [{ disposition: "blocking" as const, severity: "medium" }, { disposition: "advisory" as const, severity: "high" }]) {
    assert.equal(visualReviewStatus({ verdict: "pass", dimensions: [{ verdict: "pass" }], findings: [finding] }), "repair");
  }
});

test("unsupported repair and unavailable confidence cannot become passes", () => {
  assert.equal(visualReviewStatus({ verdict: "repair", dimensions: [], findings: [] }), "inconclusive");
  assert.equal(visualReviewStatus({ verdict: "inconclusive", dimensions: [], findings: [] }), "inconclusive");
});
