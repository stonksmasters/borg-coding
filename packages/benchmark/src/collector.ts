import type { FrontendAutonomyBenchmark } from "./contracts.ts";
import type { FrontendBenchmarkRunnerOutcome } from "./runner.ts";
import { benchmarkViolationCodes } from "./violations.ts";

export interface BenchmarkTimelineEntry {
  at: string;
  kind: "observation" | "event";
  taskId: string | null;
  sliceIndex: number | null;
  sliceTitle: string | null;
  stage: string | null;
  state: string | null;
  nextAction: string | null;
  sourceType: string | null;
  status: string | null;
  detail: string | null;
}

export interface BenchmarkContextTelemetry {
  taskId: string;
  sliceTitle: string | null;
  workflowVersion: number | null;
  packId: string;
  sliceId: string | null;
  kind: string | null;
  stage: string | null;
  characters: number;
  budgetCharacters: number;
  utilization: number;
  manifestCount: number | null;
  createdAt: string | null;
}

export interface BenchmarkModelContextTelemetry {
  taskId: string;
  id: string;
  role: string | null;
  model: string | null;
  sliceId: string | null;
  manifestCount: number | null;
  createdAt: string | null;
}

export interface BenchmarkRepairTelemetry {
  taskId: string;
  sliceTitle: string | null;
  repairAttempt: number;
  attemptPhase: string | null;
  events: Array<{
    id: string;
    sourceType: string;
    status: string | null;
    occurredAt: string;
    detail: string | null;
  }>;
}

export interface BenchmarkVerificationTelemetry {
  taskId: string;
  sliceTitle: string | null;
  persistedStatus: string | null;
  persistedAttempt: number | null;
  preDeliveryCheckpoint: boolean;
  events: Array<{
    id: string;
    sourceType: string;
    status: string | null;
    occurredAt: string;
    detail: string | null;
  }>;
}

export interface BenchmarkTelemetrySummary {
  version: 1;
  benchmarkId: string;
  benchmarkName: string;
  runId: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  sessionId: string | null;
  taskCount: number;
  observedSliceCount: number;
  observedSlices: Array<{
    index: number;
    title: string | null;
    taskId: string | null;
  }>;
  approvals: {
    projectPlan: number;
    projectPlanRevision: number;
  };
  planning: {
    outerReplanEventCount: number;
  };
  context: {
    packCount: number;
    maximumCharacters: number;
    averageCharacters: number;
    peakUtilization: number;
    configuredMaximumCharacters: number;
  };
  repair: {
    tasksWithRepair: number;
    maximumRepairAttempt: number;
    recoveryEventCount: number;
  };
  verification: {
    taskCount: number;
    passedTaskCount: number;
    failedTaskCount: number;
    preDeliveryCheckpointCount: number;
  };
  failures: {
    count: number;
    byCategory: Record<string, number>;
    codes: string[];
  };
  invariantViolationCount: number;
}

export interface BenchmarkTelemetryArtifacts {
  summary: BenchmarkTelemetrySummary;
  timeline: BenchmarkTimelineEntry[];
  contexts: {
    packs: BenchmarkContextTelemetry[];
    modelContexts: BenchmarkModelContextTelemetry[];
  };
  repairs: BenchmarkRepairTelemetry[];
  verification: BenchmarkVerificationTelemetry[];
  invariants: {
    passed: boolean;
    violations: Array<{
      code: string;
      category: string;
      message: string;
      taskId: string | null;
      sliceId: string | null;
    }>;
  };
}

function safeRunStamp(value: string) {
  return value.replace(/[^0-9A-Za-z]+/g, "-").replace(/^-+|-+$/g, "");
}

export function benchmarkRunId(benchmarkId: string, startedAt: string) {
  return `${benchmarkId}-${safeRunStamp(startedAt)}`;
}

function eventDetail(event: { data?: Record<string, unknown>; [key: string]: unknown }) {
  const data = event.data ?? {};
  for (const key of ["detail", "reason", "message", "summary"]) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function repairEvent(sourceType: string) {
  return sourceType.includes("REPAIR")
    || sourceType.includes("RECOVERY")
    || sourceType === "IMPLEMENTATION_FAILURE_CLASSIFIED"
    || sourceType === "IMPLEMENTATION_NO_PROGRESS"
    || sourceType.startsWith("IMPLEMENTATION_RECOVERY_");
}

function verificationEvent(sourceType: string) {
  return sourceType === "VERIFICATION_COMPLETED"
    || sourceType.includes("BROWSER_VERIFICATION")
    || sourceType === "VISUAL_REGRESSION_COMPLETED"
    || sourceType === "VISUAL_BASELINES_ACCEPTED";
}

function distinctEvents<T extends { id: string }>(values: T[]) {
  const map = new Map<string, T>();
  for (const value of values) map.set(value.id, value);
  return [...map.values()];
}

function compactObservations(outcome: FrontendBenchmarkRunnerOutcome) {
  const compacted: typeof outcome.observations = [];
  let previous = "";
  for (const item of outcome.observations) {
    const signature = [
      item.taskId,
      item.taskState,
      item.workflowSource,
      item.stage,
      item.nextAction,
      item.sliceIndex,
      item.sliceTitle,
      item.approvalGate,
      item.runtimeActive,
    ].join("|");
    if (signature === previous) continue;
    previous = signature;
    compacted.push(item);
  }
  return compacted;
}

export function collectBenchmarkTelemetry(
  benchmark: FrontendAutonomyBenchmark,
  outcome: FrontendBenchmarkRunnerOutcome,
): BenchmarkTelemetryArtifacts {
  const runId = benchmarkRunId(benchmark.id, outcome.result.startedAt);
  const packs: BenchmarkContextTelemetry[] = [];
  const modelContexts: BenchmarkModelContextTelemetry[] = [];
  const repairs: BenchmarkRepairTelemetry[] = [];
  const verification: BenchmarkVerificationTelemetry[] = [];
  const timeline: BenchmarkTimelineEntry[] = compactObservations(outcome).map((item) => ({
    at: item.at,
    kind: "observation",
    taskId: item.taskId,
    sliceIndex: item.sliceIndex,
    sliceTitle: item.sliceTitle,
    stage: item.stage,
    state: item.taskState,
    nextAction: item.nextAction,
    sourceType: null,
    status: null,
    detail: item.approvalGate ? `approval:${item.approvalGate}` : null,
  }));

  for (const snapshot of outcome.snapshots) {
    const sliceIndex = typeof snapshot.workflow?.sliceIndex === "number" ? snapshot.workflow.sliceIndex : null;
    const sliceTitle = typeof snapshot.workflow?.sliceTitle === "string" ? snapshot.workflow.sliceTitle : null;
    for (const pack of snapshot.contextPacks) {
      const extended = pack as typeof pack & {
        kind?: string;
        stage?: string;
        workflowVersion?: number | null;
        manifestCount?: number;
        createdAt?: string;
      };
      packs.push({
        taskId: snapshot.task.id,
        sliceTitle,
        workflowVersion: typeof extended.workflowVersion === "number" ? extended.workflowVersion : null,
        packId: pack.id,
        sliceId: pack.sliceId,
        kind: typeof extended.kind === "string" ? extended.kind : null,
        stage: typeof extended.stage === "string" ? extended.stage : null,
        characters: pack.characters,
        budgetCharacters: pack.budgetCharacters,
        utilization: pack.budgetCharacters > 0 ? pack.characters / pack.budgetCharacters : 0,
        manifestCount: typeof extended.manifestCount === "number" ? extended.manifestCount : null,
        createdAt: typeof extended.createdAt === "string" ? extended.createdAt : null,
      });
    }

    const snapshotModelContexts = Array.isArray(snapshot.modelContexts) ? snapshot.modelContexts : [];
    for (const context of snapshotModelContexts) {
      modelContexts.push({
        taskId: snapshot.task.id,
        id: context.id,
        role: typeof context.role === "string" ? context.role : null,
        model: typeof context.model === "string" ? context.model : null,
        sliceId: typeof context.sliceId === "string" ? context.sliceId : null,
        manifestCount: typeof context.manifestCount === "number" ? context.manifestCount : null,
        createdAt: typeof context.createdAt === "string" ? context.createdAt : null,
      });
    }

    const repairEvents = distinctEvents(snapshot.events.filter((event) => repairEvent(event.sourceType)));
    repairs.push({
      taskId: snapshot.task.id,
      sliceTitle,
      repairAttempt: snapshot.workflow?.repairAttempt ?? 0,
      attemptPhase: typeof snapshot.workflow?.attemptPhase === "string" ? snapshot.workflow.attemptPhase : null,
      events: repairEvents.map((event) => ({
        id: event.id,
        sourceType: event.sourceType,
        status: typeof event.status === "string" ? event.status : null,
        occurredAt: event.occurredAt,
        detail: eventDetail(event),
      })),
    });

    const verificationEvents = distinctEvents(snapshot.events.filter((event) => verificationEvent(event.sourceType)));
    verification.push({
      taskId: snapshot.task.id,
      sliceTitle,
      persistedStatus: snapshot.workflow?.verification?.status ?? null,
      persistedAttempt: typeof snapshot.workflow?.verification?.attempt === "number"
        ? snapshot.workflow.verification.attempt
        : null,
      preDeliveryCheckpoint: snapshot.checkpoints.some((checkpoint) =>
        checkpoint.kind === "pre_delivery" && checkpoint.verification?.status === "passed"),
      events: verificationEvents.map((event) => ({
        id: event.id,
        sourceType: event.sourceType,
        status: typeof event.status === "string" ? event.status : null,
        occurredAt: event.occurredAt,
        detail: eventDetail(event),
      })),
    });

    for (const event of distinctEvents(snapshot.events)) {
      timeline.push({
        at: event.occurredAt,
        kind: "event",
        taskId: snapshot.task.id,
        sliceIndex,
        sliceTitle,
        stage: null,
        state: null,
        nextAction: null,
        sourceType: event.sourceType,
        status: typeof event.status === "string" ? event.status : null,
        detail: eventDetail(event),
      });
    }
  }

  timeline.sort((a, b) => a.at.localeCompare(b.at));

  const uniqueSlices = new Map<number, { index: number; title: string | null; taskId: string | null }>();
  for (const observation of outcome.observations) {
    if (observation.sliceIndex === null) continue;
    uniqueSlices.set(observation.sliceIndex, {
      index: observation.sliceIndex,
      title: observation.sliceTitle,
      taskId: observation.taskId,
    });
  }
  const observedSlices = [...uniqueSlices.values()].sort((a, b) => a.index - b.index);

  const contextChars = packs.map((pack) => pack.characters);
  const failureCategories: Record<string, number> = {};
  for (const item of outcome.result.failures) {
    failureCategories[item.category] = (failureCategories[item.category] ?? 0) + 1;
  }
  const outerReplanEventCount = distinctEvents(
    outcome.snapshots.flatMap((snapshot) =>
      snapshot.events.filter((event) =>
        event.sourceType === "PROJECT_PLAN_PROPOSED"
        && typeof snapshot.workflow?.sliceIndex === "number"),
    ),
  ).length;

  const violationSet = new Set<string>(benchmarkViolationCodes);
  const violations = outcome.result.failures
    .filter((item) => violationSet.has(item.code))
    .map((item) => ({
      code: item.code,
      category: item.category,
      message: item.message,
      taskId: item.taskId,
      sliceId: item.sliceId,
    }));

  const startedMs = Date.parse(outcome.result.startedAt);
  const completedMs = outcome.result.completedAt ? Date.parse(outcome.result.completedAt) : Number.NaN;
  const durationMs = Number.isFinite(startedMs) && Number.isFinite(completedMs)
    ? Math.max(0, completedMs - startedMs)
    : null;

  return {
    summary: {
      version: 1,
      benchmarkId: benchmark.id,
      benchmarkName: benchmark.name,
      runId,
      status: outcome.result.status,
      startedAt: outcome.result.startedAt,
      completedAt: outcome.result.completedAt,
      durationMs,
      sessionId: outcome.sessionId,
      taskCount: outcome.taskIds.length,
      observedSliceCount: observedSlices.length,
      observedSlices,
      approvals: { ...outcome.approvals },
      planning: {
        outerReplanEventCount,
      },
      context: {
        packCount: packs.length,
        maximumCharacters: contextChars.length ? Math.max(...contextChars) : 0,
        averageCharacters: contextChars.length
          ? Math.round(contextChars.reduce((sum, value) => sum + value, 0) / contextChars.length)
          : 0,
        peakUtilization: packs.length ? Math.max(...packs.map((pack) => pack.utilization)) : 0,
        configuredMaximumCharacters: benchmark.limits.maxContextCharacters,
      },
      repair: {
        tasksWithRepair: repairs.filter((item) => item.repairAttempt > 0 || item.events.length > 0).length,
        maximumRepairAttempt: repairs.length ? Math.max(...repairs.map((item) => item.repairAttempt)) : 0,
        recoveryEventCount: repairs.reduce((sum, item) => sum + item.events.length, 0),
      },
      verification: {
        taskCount: verification.length,
        passedTaskCount: verification.filter((item) => item.persistedStatus === "passed").length,
        failedTaskCount: verification.filter((item) => item.persistedStatus === "failed").length,
        preDeliveryCheckpointCount: verification.filter((item) => item.preDeliveryCheckpoint).length,
      },
      failures: {
        count: outcome.result.failures.length,
        byCategory: failureCategories,
        codes: outcome.result.failures.map((item) => item.code),
      },
      invariantViolationCount: violations.length,
    },
    timeline,
    contexts: { packs, modelContexts },
    repairs,
    verification,
    invariants: {
      passed: violations.length === 0,
      violations,
    },
  };
}
