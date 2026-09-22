import assert from "node:assert/strict";
import test from "node:test";
import { parseFrontendAutonomyBenchmark } from "../packages/benchmark/src/contracts.ts";
import type { BenchmarkDebugSnapshot } from "../packages/benchmark/src/borg-client.ts";
import type { BenchmarkObservation } from "../packages/benchmark/src/observer.ts";
import { evaluateBenchmarkInvariants } from "../packages/benchmark/src/invariants.ts";

const benchmark = parseFrontendAutonomyBenchmark({
  version: 1,
  id: "invariant-test",
  name: "Invariant test",
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

function observation(input: Partial<BenchmarkObservation> & Pick<BenchmarkObservation, "taskId" | "sliceIndex">): BenchmarkObservation {
  return {
    at: new Date().toISOString(),
    taskId: input.taskId,
    taskState: input.taskState ?? "COMPLETE",
    runtimeActive: input.runtimeActive ?? false,
    approvalGate: input.approvalGate ?? null,
    workflowSource: input.workflowSource ?? "sqlite",
    stage: input.stage ?? "ready",
    nextAction: input.nextAction ?? "advance_slice",
    sliceIndex: input.sliceIndex,
    sliceTotal: input.sliceTotal ?? 2,
    sliceTitle: input.sliceTitle ?? (input.sliceIndex === 0 ? "Home" : "Work"),
  };
}

function snapshot(
  taskId: string,
  sliceIndex: number,
  overrides: Partial<BenchmarkDebugSnapshot> = {},
): BenchmarkDebugSnapshot {
  const value: BenchmarkDebugSnapshot = {
    version: 1,
    generatedAt: new Date().toISOString(),
    readOnly: true,
    task: { id: taskId, state: "COMPLETE", attempts: 0 },
    workflow: {
      version: sliceIndex + 3,
      phase: "frontend",
      status: sliceIndex === 1 ? "awaiting_feedback" : "running",
      sliceIndex,
      sliceTotal: 2,
      sliceTitle: sliceIndex === 0 ? "Home" : "Work",
      nextAction: sliceIndex === 1 ? "request_feedback" : "advance_slice",
      repairAttempt: 0,
      attemptPhase: "implementation",
      verification: { status: "passed", attempt: 0 },
      projectPlan: {
        backendRequired: false,
        sitemap: [{ route: "/" }, { route: "/work" }],
      },
    },
    approval: {
      status: "APPROVED",
      worktreePath: `/tmp/${taskId}`,
      baseCommit: "base",
    },
    events: [],
    contextPacks: [{
      id: `pack-${taskId}`,
      sliceId: sliceIndex === 0 ? "home" : "work",
      characters: 12_000,
      budgetCharacters: 24_000,
    }],
    git: {
      worktreePath: `/tmp/${taskId}`,
      worktreeExists: true,
      baseCommit: "base",
      headCommit: "head",
    },
    checkpoints: [{
      id: `checkpoint-${taskId}`,
      kind: "pre_delivery",
      taskState: "DELIVERY_READY",
      workflowVersion: sliceIndex + 3,
      verification: { status: "passed" },
    }],
    diagnostics: [],
  };
  return {
    ...value,
    ...overrides,
    task: { ...value.task, ...(overrides.task ?? {}) },
    workflow: overrides.workflow === null ? null : { ...value.workflow, ...(overrides.workflow ?? {}) },
    approval: overrides.approval === null ? null : { ...value.approval, ...(overrides.approval ?? {}) },
    git: { ...value.git, ...(overrides.git ?? {}) },
  };
}

function evaluate(input: {
  observations?: BenchmarkObservation[];
  snapshots?: BenchmarkDebugSnapshot[];
  revisions?: number;
  completionClaimed?: boolean;
} = {}) {
  return evaluateBenchmarkInvariants({
    benchmark,
    observations: input.observations ?? [
      observation({ taskId: "home-task", sliceIndex: 0, nextAction: "advance_slice" }),
      observation({ taskId: "work-task", sliceIndex: 1, nextAction: "request_feedback" }),
    ],
    snapshots: input.snapshots ?? [snapshot("home-task", 0), snapshot("work-task", 1)],
    approvals: { projectPlan: 1, projectPlanRevision: input.revisions ?? 0 },
    completionClaimed: input.completionClaimed ?? true,
  });
}

test("clean durable two-slice evidence satisfies benchmark invariants", () => {
  assert.deepEqual(evaluate(), []);
});

test("fresh outer replanning during slice repair is rejected while bounded plan revision is allowed", () => {
  const repaired = snapshot("home-task", 0, {
    task: { id: "home-task", state: "IMPLEMENTING", attempts: 1 },
    workflow: {
      version: 8,
      phase: "frontend",
      status: "running",
      sliceIndex: 0,
      sliceTotal: 2,
      sliceTitle: "Home",
      nextAction: "repair",
      repairAttempt: 1,
      attemptPhase: "technical_repair",
      verification: { status: "failed", attempt: 1 },
      projectPlan: { backendRequired: false, sitemap: [{ route: "/" }, { route: "/work" }] },
    },
    events: [{
      id: "fresh-plan",
      sourceType: "PROJECT_PLAN_PROPOSED",
      occurredAt: new Date().toISOString(),
      workflowVersion: 8,
      status: "waiting",
      data: {},
    }],
  });
  const invalid = evaluate({ snapshots: [repaired], observations: [observation({ taskId: "home-task", sliceIndex: 0 })], completionClaimed: false });
  assert.equal(invalid.some((item) => item.code === "PROJECT_REPLANNED_DURING_SLICE_REPAIR"), true);

  const revised = snapshot("home-task", 0, {
    events: [{
      id: "bounded-revision",
      sourceType: "PROJECT_PLAN_REVISION_PROPOSED",
      occurredAt: new Date().toISOString(),
      workflowVersion: 8,
      status: "waiting",
      data: { repairScope: "project_plan" },
    }],
  });
  const valid = evaluate({ snapshots: [revised], observations: [observation({ taskId: "home-task", sliceIndex: 0 })], revisions: 1, completionClaimed: false });
  assert.equal(valid.some((item) => item.code.includes("REPLAN")), false);
  assert.equal(valid.some((item) => item.code === "PROJECT_PLAN_REVISION_LIMIT_EXCEEDED"), false);
});

test("plan revision count is bounded by the benchmark contract", () => {
  const failures = evaluate({ revisions: 2, completionClaimed: false });
  assert.equal(failures.some((item) => item.code === "PROJECT_PLAN_REVISION_LIMIT_EXCEEDED"), true);
});

test("slice advancement requires a pre-delivery checkpoint and passed verification", () => {
  const broken = snapshot("home-task", 0, {
    workflow: {
      version: 3,
      phase: "frontend",
      status: "running",
      sliceIndex: 0,
      sliceTotal: 2,
      sliceTitle: "Home",
      nextAction: "advance_slice",
      repairAttempt: 0,
      attemptPhase: "implementation",
      verification: { status: "failed", attempt: 0 },
      projectPlan: { backendRequired: false, sitemap: [{ route: "/" }, { route: "/work" }] },
    },
    checkpoints: [],
  });
  const failures = evaluate({
    snapshots: [broken, snapshot("work-task", 1)],
  });
  assert.equal(failures.some((item) => item.code === "ADVANCED_WITHOUT_CHECKPOINT"), true);
  assert.equal(failures.some((item) => item.code === "ADVANCED_WITHOUT_PASSED_VERIFICATION"), true);
});

test("context characters are bounded by both the benchmark and compiled pack budget", () => {
  const over = snapshot("home-task", 0, {
    contextPacks: [{
      id: "oversized",
      sliceId: "home",
      characters: 24_001,
      budgetCharacters: 40_000,
    }],
  });
  const failures = evaluate({ snapshots: [over], observations: [observation({ taskId: "home-task", sliceIndex: 0 })], completionClaimed: false });
  assert.equal(failures.some((item) => item.code === "CONTEXT_BUDGET_EXCEEDED"), true);
});

test("completion validates verification, minimum page count, required routes, and frontend-only scope", () => {
  const final = snapshot("work-task", 1, {
    workflow: {
      version: 9,
      phase: "frontend",
      status: "awaiting_feedback",
      sliceIndex: 1,
      sliceTotal: 2,
      sliceTitle: "Work",
      nextAction: "request_feedback",
      repairAttempt: 0,
      attemptPhase: "implementation",
      verification: { status: "failed", attempt: 0 },
      projectPlan: {
        backendRequired: true,
        sitemap: [{ route: "/" }],
      },
    },
  });
  const failures = evaluate({
    observations: [observation({ taskId: "work-task", sliceIndex: 1, nextAction: "request_feedback" })],
    snapshots: [final],
  });
  const codes = new Set(failures.map((item) => item.code));
  assert.equal(codes.has("FRONTEND_COMPLETION_WITHOUT_PASSED_VERIFICATION"), true);
  assert.equal(codes.has("FRONTEND_COMPLETION_BEFORE_MINIMUM_PAGES"), true);
  assert.equal(codes.has("REQUIRED_ROUTE_MISSING"), true);
  assert.equal(codes.has("BACKEND_REQUIRED_IN_FRONTEND_ONLY_BENCHMARK"), true);
});

test("non-SQLite workflow projection cannot satisfy benchmark authority", () => {
  const failures = evaluate({
    observations: [
      observation({ taskId: "home-task", sliceIndex: 0, workflowSource: "legacy_projection" }),
    ],
    snapshots: [snapshot("home-task", 0)],
    completionClaimed: false,
  });
  assert.equal(failures.some((item) => item.code === "WORKFLOW_SOURCE_NOT_SQLITE"), true);
});
