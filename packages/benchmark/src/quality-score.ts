import type { FrontendAutonomyBenchmark } from "./contracts.ts";
import type { FrontendBenchmarkRunnerOutcome } from "./runner.ts";

export interface BenchmarkQualityCategory {
  earned: number;
  maximum: number;
  ratio: number;
}

export interface BenchmarkQualityScore {
  earned: number;
  maximum: 100;
  threshold: 95;
  categoryFloor: 0.9;
  runExceptional: boolean;
  exceptional: boolean;
  repeatability: { required: 3; consecutiveExceptionalRuns: number; satisfied: boolean };
  categories: {
    completion: BenchmarkQualityCategory;
    functional: BenchmarkQualityCategory;
    responsive: BenchmarkQualityCategory;
    accessibility: BenchmarkQualityCategory;
    visual: BenchmarkQualityCategory;
    engineering: BenchmarkQualityCategory;
    reliability: BenchmarkQualityCategory;
  };
}

function category(maximum: number, ratio: number): BenchmarkQualityCategory {
  const bounded = Math.max(0, Math.min(1, ratio));
  return { earned: Math.round(maximum * bounded), maximum, ratio: bounded };
}

function eventPassed(snapshot: FrontendBenchmarkRunnerOutcome["snapshots"][number], sourceType: string) {
  return snapshot.events.some((event) => {
    if (event.sourceType !== sourceType) return false;
    if (event.data?.passed === true) return true;
    const review = event.data?.review;
    if (!review || typeof review !== "object") return false;
    const value = review as Record<string, unknown>;
    return value.status === "pass" || value.verdict === "pass";
  });
}

export function benchmarkQualityScore(
  benchmark: FrontendAutonomyBenchmark,
  outcome: FrontendBenchmarkRunnerOutcome,
): BenchmarkQualityScore {
  const observedTaskIds = [...new Set(outcome.observations
    .filter((item) => item.sliceIndex !== null)
    .map((item) => item.taskId))];
  const snapshots = observedTaskIds
    .map((taskId) => [...outcome.snapshots].reverse().find((item) => item.task.id === taskId))
    .filter((item): item is FrontendBenchmarkRunnerOutcome["snapshots"][number] => Boolean(item));
  const denominator = Math.max(benchmark.expected.minimumPages, observedTaskIds.length, 1);
  const fraction = (count: number) => count / denominator;
  const verified = snapshots.filter((item) => item.workflow?.verification?.status === "passed").length;
  const checkpointed = snapshots.filter((item) => item.checkpoints.some((checkpoint) =>
    checkpoint.kind === "pre_delivery" && checkpoint.verification?.status === "passed")).length;
  const browserPassed = snapshots.filter((item) => eventPassed(item, "FOCUSED_BROWSER_VERIFICATION_COMPLETED")).length;
  const visualPassed = snapshots.filter((item) => eventPassed(item, "DESIGN_REVIEW_COMPLETED")).length;
  const completionReached = outcome.observations.some((item) => item.nextAction === "request_feedback");
  const completed = completionReached ? Math.min(1, observedTaskIds.length / denominator) : 0;
  const repairAttempts = snapshots.reduce((sum, item) => sum + Math.max(0, item.workflow?.repairAttempt ?? item.task.attempts ?? 0), 0);
  const nonQualityFailures = outcome.result.failures.filter((item) => !item.code.startsWith("QUALITY_"));
  const reliabilityRatio = nonQualityFailures.length ? 0 : Math.max(0, 1 - repairAttempts / Math.max(1, denominator * benchmark.limits.maxRepairAttemptsPerSlice));

  const categories = {
    completion: category(15, completed),
    functional: category(15, Math.min(fraction(verified), fraction(checkpointed))),
    responsive: category(15, fraction(browserPassed)),
    accessibility: category(15, fraction(browserPassed)),
    visual: category(20, fraction(visualPassed)),
    engineering: category(10, fraction(verified)),
    reliability: category(10, reliabilityRatio),
  };
  const earned = Object.values(categories).reduce((sum, item) => sum + item.earned, 0);
  const categoryFloor = 0.9 as const;
  const threshold = 95 as const;
  const runExceptional = outcome.result.status === "PASS"
    && outcome.result.failures.length === 0
    && earned >= threshold
    && Object.values(categories).every((item) => item.ratio >= categoryFloor);
  return {
    earned,
    maximum: 100,
    threshold,
    categoryFloor,
    runExceptional,
    exceptional: false,
    repeatability: { required: 3, consecutiveExceptionalRuns: runExceptional ? 1 : 0, satisfied: false },
    categories,
  };
}
