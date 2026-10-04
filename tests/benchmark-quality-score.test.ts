import assert from "node:assert/strict";
import test from "node:test";
import { parseFrontendAutonomyBenchmark } from "../packages/benchmark/src/contracts.ts";
import { benchmarkQualityScore } from "../packages/benchmark/src/quality-score.ts";
import type { FrontendBenchmarkRunnerOutcome } from "../packages/benchmark/src/runner.ts";

const benchmark = parseFrontendAutonomyBenchmark({
  version: 1, id: "quality-test", name: "Quality test", kind: "frontend-autonomy", promptPath: "prompt.md",
  expected: { frontendOnly: true, requiredRoutes: ["/"], minimumPages: 1, requireBrowserVerification: true, requireResponsiveVerification: true, requireAccessibilityVerification: true, requireFrontendComplete: true },
  limits: { maxProjectPlanRevisions: 1, maxRepairAttemptsPerSlice: 3, maxContextCharacters: 24_000 },
});

function outcome(events: FrontendBenchmarkRunnerOutcome["snapshots"][number]["events"]): FrontendBenchmarkRunnerOutcome {
  return {
    result: { version: 1, benchmarkId: benchmark.id, status: "PASS", startedAt: "2026-10-03T00:00:00.000Z", completedAt: "2026-10-03T00:01:00.000Z", failures: [] },
    sessionId: "session", taskIds: ["home"], approvals: { projectPlan: 1, projectPlanRevision: 0 },
    observations: [{ at: "2026-10-03T00:00:30.000Z", taskId: "home", taskState: "COMPLETE", runtimeActive: false, approvalGate: null, workflowSource: "sqlite", stage: "ready", nextAction: "request_feedback", sliceIndex: 0, sliceTotal: 1, sliceTitle: "Home" }],
    snapshots: [{
      version: 1, generatedAt: "2026-10-03T00:00:30.000Z", readOnly: true,
      task: { id: "home", state: "COMPLETE", attempts: 0 },
      workflow: { sliceIndex: 0, sliceTitle: "Home", repairAttempt: 0, verification: { status: "passed", attempt: 0 }, projectPlan: { backendRequired: false, sitemap: [{ route: "/" }] } },
      approval: { status: "APPROVED", worktreePath: "/tmp/home" }, events, contextPacks: [],
      git: { worktreePath: "/tmp/home", worktreeExists: true },
      checkpoints: [{ id: "delivery", kind: "pre_delivery", taskState: "DELIVERY_READY", verification: { status: "passed" } }],
    }],
  };
}

test("exceptional quality requires passed browser and design evidence", () => {
  const score = benchmarkQualityScore(benchmark, outcome([
    { id: "browser", sourceType: "FOCUSED_BROWSER_VERIFICATION_COMPLETED", occurredAt: "2026-10-03T00:00:20.000Z", data: { passed: true } },
    { id: "design", sourceType: "DESIGN_REVIEW_COMPLETED", occurredAt: "2026-10-03T00:00:25.000Z", data: { review: { status: "pass" } } },
  ]));
  assert.equal(score.earned, 100);
  assert.equal(score.runExceptional, true);
  assert.equal(score.exceptional, false, "three persisted qualifying runs are required");
  assert.equal(score.repeatability.consecutiveExceptionalRuns, 1);
});

test("missing visual review cannot meet the category floor", () => {
  const score = benchmarkQualityScore(benchmark, outcome([
    { id: "browser", sourceType: "FOCUSED_BROWSER_VERIFICATION_COMPLETED", occurredAt: "2026-10-03T00:00:20.000Z", data: { passed: true } },
  ]));
  assert.equal(score.categories.visual.earned, 0);
  assert.equal(score.earned, 80);
  assert.equal(score.exceptional, false);
});
