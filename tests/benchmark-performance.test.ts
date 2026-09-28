import assert from "node:assert/strict";
import test from "node:test";
import { benchmarkPerformance } from "../packages/benchmark/src/performance.ts";
import type { FrontendBenchmarkRunnerOutcome } from "../packages/benchmark/src/runner.ts";

test("benchmark timing accounts for unobserved time without inventing render or usage evidence", () => {
  const outcome = {
    result: { startedAt: "2026-09-26T00:00:00Z", completedAt: "2026-09-26T00:01:00Z" },
    observations: [
      { at: "2026-09-26T00:00:10Z", taskState: "PLANNING", stage: "planning" },
      { at: "2026-09-26T00:00:30Z", taskState: "IMPLEMENTING", stage: "implementing" },
      { at: "2026-09-26T00:00:50Z", taskState: "VERIFYING", stage: "verifying" },
    ], snapshots: [],
  } as unknown as FrontendBenchmarkRunnerOutcome;
  const report = benchmarkPerformance(outcome);
  assert.equal(report.stageMs.planning, 20_000);
  assert.equal(report.stageMs.generating, 20_000);
  assert.equal(report.stageMs.verifying, 10_000);
  assert.equal(report.unobservedMs, 10_000);
  assert.equal(report.firstRenderedPreviewMs, null);
  assert.equal(report.recordedModelRequests, null);
});
