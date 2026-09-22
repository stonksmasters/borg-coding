import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseFrontendAutonomyBenchmark } from "../packages/benchmark/src/contracts.ts";
import type { FrontendBenchmarkRunnerOutcome } from "../packages/benchmark/src/runner.ts";
import { collectBenchmarkTelemetry } from "../packages/benchmark/src/collector.ts";
import { formatBenchmarkReport } from "../packages/benchmark/src/report.ts";
import { writeBenchmarkArtifacts } from "../packages/benchmark/src/writer.ts";

const benchmark = parseFrontendAutonomyBenchmark({
  version: 1,
  id: "telemetry-test",
  name: "Telemetry Test",
  kind: "frontend-autonomy",
  promptPath: "prompt.md",
  expected: {
    frontendOnly: true,
    requiredRoutes: ["/", "/work"],
    minimumPages: 2,
    requireBrowserVerification: true,
    requireResponsiveVerification: true,
    requireAccessibilityVerification: true,
    requireFrontendComplete: true,
  },
  limits: {
    maxProjectPlanRevisions: 1,
    maxRepairAttemptsPerSlice: 3,
    maxContextCharacters: 24_000,
  },
});

function outcome(): FrontendBenchmarkRunnerOutcome {
  return {
    result: {
      version: 1,
      benchmarkId: benchmark.id,
      status: "FAIL",
      startedAt: "2026-09-22T14:00:00.000Z",
      completedAt: "2026-09-22T14:02:30.000Z",
      failures: [{
        code: "CONTEXT_BUDGET_EXCEEDED",
        category: "context",
        message: "Context grew past the benchmark limit.",
        taskId: "home-task",
        sliceId: "home",
      }],
    },
    sessionId: "session-1",
    taskIds: ["plan-task", "home-task", "work-task"],
    observations: [
      {
        at: "2026-09-22T14:00:10.000Z",
        taskId: "home-task",
        taskState: "IMPLEMENTING",
        runtimeActive: true,
        approvalGate: null,
        workflowSource: "sqlite",
        stage: "implementing",
        nextAction: "implement",
        sliceIndex: 0,
        sliceTotal: 2,
        sliceTitle: "Home",
      },
      {
        at: "2026-09-22T14:00:11.000Z",
        taskId: "home-task",
        taskState: "IMPLEMENTING",
        runtimeActive: true,
        approvalGate: null,
        workflowSource: "sqlite",
        stage: "implementing",
        nextAction: "implement",
        sliceIndex: 0,
        sliceTotal: 2,
        sliceTitle: "Home",
      },
      {
        at: "2026-09-22T14:01:30.000Z",
        taskId: "work-task",
        taskState: "COMPLETE",
        runtimeActive: false,
        approvalGate: null,
        workflowSource: "sqlite",
        stage: "ready",
        nextAction: "request_feedback",
        sliceIndex: 1,
        sliceTotal: 2,
        sliceTitle: "Work",
      },
    ],
    snapshots: [
      {
        version: 1,
        generatedAt: "2026-09-22T14:01:00.000Z",
        readOnly: true,
        task: { id: "home-task", state: "COMPLETE", attempts: 1 },
        workflow: {
          version: 4,
          phase: "frontend",
          status: "running",
          sliceIndex: 0,
          sliceTotal: 2,
          sliceTitle: "Home",
          nextAction: "advance_slice",
          repairAttempt: 1,
          attemptPhase: "technical_repair",
          verification: { status: "passed", attempt: 1 },
          projectPlan: { backendRequired: false, sitemap: [{ route: "/" }, { route: "/work" }] },
        },
        approval: { status: "APPROVED", worktreePath: "/tmp/home", baseCommit: "base" },
        events: [
          {
            id: "repair-1",
            sourceType: "IMPLEMENTATION_RECOVERY_SCHEDULED",
            occurredAt: "2026-09-22T14:00:30.000Z",
            status: "active",
            data: { reason: "Missing section module." },
          },
          {
            id: "verify-1",
            sourceType: "VERIFICATION_COMPLETED",
            occurredAt: "2026-09-22T14:00:50.000Z",
            status: "succeeded",
            data: { summary: "Verification passed." },
          },
        ],
        contextPacks: [
          {
            id: "pack-home",
            sliceId: "home",
            characters: 25_000,
            budgetCharacters: 30_000,
            kind: "slice",
            stage: "repair",
            workflowVersion: 4,
            manifestCount: 9,
            createdAt: "2026-09-22T14:00:20.000Z",
          },
        ],
        modelContexts: [{
          id: "model-home",
          role: "implementer",
          model: "test-model",
          sliceId: "home",
          manifestCount: 9,
          createdAt: "2026-09-22T14:00:21.000Z",
        }],
        git: { worktreePath: "/tmp/home", worktreeExists: true, baseCommit: "base", headCommit: "head" },
        checkpoints: [{
          id: "cp-home",
          kind: "pre_delivery",
          taskState: "DELIVERY_READY",
          verification: { status: "passed" },
        }],
        diagnostics: [],
      },
      {
        version: 1,
        generatedAt: "2026-09-22T14:02:20.000Z",
        readOnly: true,
        task: { id: "work-task", state: "COMPLETE", attempts: 0 },
        workflow: {
          version: 5,
          phase: "frontend",
          status: "awaiting_feedback",
          sliceIndex: 1,
          sliceTotal: 2,
          sliceTitle: "Work",
          nextAction: "request_feedback",
          repairAttempt: 0,
          attemptPhase: "implementation",
          verification: { status: "passed", attempt: 0 },
          projectPlan: { backendRequired: false, sitemap: [{ route: "/" }, { route: "/work" }] },
        },
        approval: { status: "APPROVED", worktreePath: "/tmp/work", baseCommit: "base" },
        events: [{
          id: "verify-2",
          sourceType: "BROWSER_VERIFICATION_COMPLETED",
          occurredAt: "2026-09-22T14:02:00.000Z",
          status: "succeeded",
          data: { detail: "Responsive verification passed." },
        }],
        contextPacks: [{
          id: "pack-work",
          sliceId: "work",
          characters: 12_000,
          budgetCharacters: 24_000,
          kind: "slice",
          stage: "implementation",
          workflowVersion: 5,
          manifestCount: 7,
          createdAt: "2026-09-22T14:01:40.000Z",
        }],
        modelContexts: [],
        git: { worktreePath: "/tmp/work", worktreeExists: true, baseCommit: "base", headCommit: "head" },
        checkpoints: [{
          id: "cp-work",
          kind: "pre_delivery",
          taskState: "DELIVERY_READY",
          verification: { status: "passed" },
        }],
        diagnostics: [],
      },
    ],
    approvals: {
      projectPlan: 1,
      projectPlanRevision: 0,
    },
  };
}

test("telemetry collector compacts observations and summarizes context, repair, verification, and invariants", () => {
  const artifacts = collectBenchmarkTelemetry(benchmark, outcome());

  assert.equal(artifacts.summary.status, "FAIL");
  assert.equal(artifacts.summary.durationMs, 150_000);
  assert.equal(artifacts.summary.taskCount, 3);
  assert.equal(artifacts.summary.observedSliceCount, 2);
  assert.equal(artifacts.summary.context.packCount, 2);
  assert.equal(artifacts.summary.context.maximumCharacters, 25_000);
  assert.equal(artifacts.summary.context.averageCharacters, 18_500);
  assert.equal(Math.round(artifacts.summary.context.peakUtilization * 100), 104);
  assert.equal(artifacts.summary.planning.outerReplanEventCount, 0);
  assert.equal(artifacts.summary.repair.tasksWithRepair, 1);
  assert.equal(artifacts.summary.repair.maximumRepairAttempt, 1);
  assert.equal(artifacts.summary.verification.passedTaskCount, 2);
  assert.equal(artifacts.summary.verification.preDeliveryCheckpointCount, 2);
  assert.equal(artifacts.summary.invariantViolationCount, 1);
  assert.equal(artifacts.summary.failures.items[0]?.message, "Context grew past the benchmark limit.");
  assert.equal(artifacts.contexts.modelContexts.length, 1);
  assert.equal(artifacts.invariants.passed, false);
  assert.equal(artifacts.invariants.violations[0]?.code, "CONTEXT_BUDGET_EXCEEDED");

  const observations = artifacts.timeline.filter((item) => item.kind === "observation");
  assert.equal(observations.length, 2, "consecutive identical observations should be compacted");
  assert.equal(artifacts.timeline.filter((item) => item.kind === "event").length, 3);
});

test("formatted report surfaces result, slices, bounded context, repairs, and invariant failures", () => {
  const report = formatBenchmarkReport(collectBenchmarkTelemetry(benchmark, outcome()));
  assert.match(report, /Result: FAIL/);
  assert.match(report, /1\. Home · passed · repair 1/);
  assert.match(report, /2\. Work · passed/);
  assert.match(report, /Project replans during slices: 0/);
  assert.match(report, /Peak: 25,000 \/ 24,000 chars/);
  assert.match(report, /Peak utilization: 104%/);
  assert.match(report, /Home: 25,000 chars/);
  assert.match(report, /Work: 12,000 chars/);
  assert.match(report, /Tasks requiring repair: 1/);
  assert.match(report, /Invariant violations: 1/);
  assert.match(report, /CONTEXT_BUDGET_EXCEEDED/);
});

test("artifact writer persists exactly the six benchmark report files under .borg", async () => {
  const root = mkdtempSync(join(tmpdir(), "borg-benchmark-report-"));
  try {
    const artifacts = collectBenchmarkTelemetry(benchmark, outcome());
    const written = await writeBenchmarkArtifacts(artifacts, root);

    assert.match(written.directory, /\.borg[\\/]benchmark-results[\\/]telemetry-test-/);
    assert.deepEqual(Object.keys(written.files).sort(), [
      "contexts",
      "invariants",
      "repairs",
      "summary",
      "timeline",
      "verification",
    ]);

    const summary = JSON.parse(readFileSync(written.files.summary, "utf8")) as { runId?: string; status?: string };
    const contexts = JSON.parse(readFileSync(written.files.contexts, "utf8")) as { packs?: unknown[]; modelContexts?: unknown[] };
    assert.equal(summary.runId, artifacts.summary.runId);
    assert.equal(summary.status, "FAIL");
    assert.equal(contexts.packs?.length, 2);
    assert.equal(contexts.modelContexts?.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("telemetry artifacts never persist raw model input from debug snapshots", async () => {
  const artifacts = collectBenchmarkTelemetry(benchmark, outcome());
  const serialized = JSON.stringify(artifacts);
  assert.doesNotMatch(serialized, /inputText|rawModelInput|system prompt/i);
});


test("formatted report includes the full message for non-invariant runner failures", () => {
  const failed = outcome();
  failed.result.failures = [{
    code: "BENCHMARK_RUNNER_ERROR",
    category: "workflow",
    message: "Choose a website name using letters or numbers (up to 60 characters).",
    taskId: null,
    sliceId: null,
  }];
  const report = formatBenchmarkReport(collectBenchmarkTelemetry(benchmark, failed));
  assert.match(
    report,
    /\[workflow\] BENCHMARK_RUNNER_ERROR: Choose a website name using letters or numbers \(up to 60 characters\)\./,
  );
});
