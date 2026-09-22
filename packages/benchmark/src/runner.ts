import type { FrontendAutonomyBenchmark } from "./contracts.ts";
import type { BenchmarkFailure, BenchmarkRunResult } from "./result.ts";
import {
  BorgBenchmarkClient,
  type BenchmarkDebugSnapshot,
  type BenchmarkSessionRuntime,
  type BenchmarkWorkflowStatus,
} from "./borg-client.ts";
import {
  approvalGate,
  isFrontendComplete,
  isWorkflowBlocked,
  isWorkflowFailure,
  observationFor,
  type BenchmarkObservation,
} from "./observer.ts";
import { evaluateBenchmarkInvariants } from "./invariants.ts";

export interface FrontendBenchmarkRunnerOptions {
  client: BorgBenchmarkClient;
  benchmark: FrontendAutonomyBenchmark;
  prompt: string;
  websiteName?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  onObservation?: (observation: BenchmarkObservation) => void;
}

export interface FrontendBenchmarkRunnerOutcome {
  result: BenchmarkRunResult;
  sessionId: string | null;
  taskIds: string[];
  observations: BenchmarkObservation[];
  snapshots: BenchmarkDebugSnapshot[];
  approvals: {
    projectPlan: number;
    projectPlanRevision: number;
  };
}

function failure(
  code: string,
  category: BenchmarkFailure["category"],
  message: string,
  taskId: string | null = null,
  sliceId: string | null = null,
): BenchmarkFailure {
  return { code, category, message, taskId, sliceId };
}

function result(
  benchmarkId: string,
  status: BenchmarkRunResult["status"],
  startedAt: string,
  completedAt: string,
  failures: BenchmarkFailure[],
): BenchmarkRunResult {
  return {
    version: 1,
    benchmarkId,
    status,
    startedAt,
    completedAt,
    failures,
  };
}

function statusSliceId(status: BenchmarkWorkflowStatus | null) {
  if (!status) return null;
  if (status.sliceIndex === null) return null;
  return status.sliceTitle || `slice-${status.sliceIndex + 1}`;
}

export function benchmarkWebsiteName(benchmarkId: string, startedAt: Date) {
  const prefix = "BORG Benchmark ";
  const stamp = startedAt.toISOString().replace(/\D/g, "").slice(0, 14);
  const maxIdLength = Math.max(1, 60 - prefix.length - stamp.length - 1);
  const compactId = benchmarkId.slice(0, maxIdLength).replace(/-+$/, "") || "run";
  return `${prefix}${compactId} ${stamp}`;
}

export async function runFrontendBenchmark(options: FrontendBenchmarkRunnerOptions): Promise<FrontendBenchmarkRunnerOutcome> {
  const {
    client,
    benchmark,
    prompt,
    onObservation,
  } = options;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const timeoutMs = options.timeoutMs ?? 30 * 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const started = now();
  const startedAt = started.toISOString();
  const deadline = Date.now() + timeoutMs;
  const observations: BenchmarkObservation[] = [];
  const taskIds: string[] = [];
  const approvals = { projectPlan: 0, projectPlanRevision: 0 };
  const snapshotByTask = new Map<string, BenchmarkDebugSnapshot>();
  let sessionId: string | null = null;

  const finish = (
    status: BenchmarkRunResult["status"],
    failures: BenchmarkFailure[],
  ): FrontendBenchmarkRunnerOutcome => {
    const snapshots = [...snapshotByTask.values()];
    const invariantFailures = evaluateBenchmarkInvariants({
      benchmark,
      observations,
      snapshots,
      approvals,
      completionClaimed: status === "PASS",
    });
    const combined = [...failures, ...invariantFailures];
    const finalStatus = status === "PASS" && invariantFailures.length ? "FAIL" : status;
    return {
      result: result(benchmark.id, finalStatus, startedAt, now().toISOString(), combined),
      sessionId,
      taskIds,
      observations,
      snapshots,
      approvals,
    };
  };

  try {
    const health = await client.health();
    if (health.core?.runtimeConnected !== true || health.core?.modelAvailable !== true) {
      return finish("INVALID_RUN", [
        failure("BORG_RUNTIME_UNAVAILABLE", "workflow", "The gateway is reachable but the configured local model runtime is not available."),
      ]);
    }

    const website = await client.createWebsite({
      name: options.websiteName ?? benchmarkWebsiteName(benchmark.id, started),
      brief: prompt,
      template: "auto",
    });
    sessionId = website.session.id;

    const planning = await client.submitPrompt(sessionId, prompt);
    if (planning.taskId && !taskIds.includes(planning.taskId)) taskIds.push(planning.taskId);

    while (Date.now() < deadline) {
      const runtime = await client.getSession(sessionId);
      if (runtime.latestTaskId && !taskIds.includes(runtime.latestTaskId)) taskIds.push(runtime.latestTaskId);

      const gate = approvalGate(runtime);
      if (gate === "project_plan" || gate === "project_plan_revision") {
        if (!runtime.latestTaskId) {
          return finish("INVALID_RUN", [
            failure("APPROVAL_WITHOUT_TASK", "workflow", "BORG exposed a project approval gate without an authoritative task id."),
          ]);
        }
        await client.approveTask(runtime.latestTaskId);
        if (gate === "project_plan") approvals.projectPlan += 1;
        else approvals.projectPlanRevision += 1;
        await sleep(pollIntervalMs);
        continue;
      }

      let workflowStatus: BenchmarkWorkflowStatus | null = null;
      if (runtime.latestTaskId) {
        workflowStatus = await client.workflowStatus(runtime.latestTaskId);
        const snapshot = await client.debugSnapshot(runtime.latestTaskId).catch(() => null);
        if (snapshot) snapshotByTask.set(runtime.latestTaskId, snapshot);
      }

      const observation = observationFor(runtime, workflowStatus);
      observations.push(observation);
      onObservation?.(observation);

      if (workflowStatus && isFrontendComplete(workflowStatus)) {
        return finish("PASS", []);
      }

      if (workflowStatus && isWorkflowFailure(workflowStatus)) {
        return finish("FAIL", [
          failure(
            "WORKFLOW_FAILED",
            "workflow",
            `BORG ended the authoritative task in ${workflowStatus.taskState}.`,
            runtime.latestTaskId,
            statusSliceId(workflowStatus),
          ),
        ]);
      }

      if (workflowStatus && isWorkflowBlocked(workflowStatus)) {
        return finish("BLOCKED", [
          failure(
            workflowStatus.run?.headline === "Visual baseline approval required"
              ? "OPERATOR_VISUAL_BASELINE_APPROVAL_REQUIRED"
              : "WORKFLOW_BLOCKED",
            workflowStatus.run?.headline === "Visual baseline approval required" ? "verification" : "workflow",
            workflowStatus.run?.blocker?.detail
              ?? workflowStatus.run?.detail
              ?? workflowStatus.run?.headline
              ?? "BORG reached a blocking workflow state.",
            runtime.latestTaskId,
            statusSliceId(workflowStatus),
          ),
        ]);
      }

      if (gate === "unknown") {
        return finish("BLOCKED", [
          failure(
            "UNSUPPORTED_OPERATOR_GATE",
            "workflow",
            "BORG requested an operator approval that is not a project-plan boundary. The benchmark runner will not authorize implementation or invent progression.",
            runtime.latestTaskId,
            statusSliceId(workflowStatus),
          ),
        ]);
      }

      if (runtime.runtimeAvailable === false) {
        return finish("INVALID_RUN", [
          failure(
            "BORG_RUNTIME_STATE_UNAVAILABLE",
            "workflow",
            "The gateway could not restore the authoritative Core task state.",
            runtime.latestTaskId,
            statusSliceId(workflowStatus),
          ),
        ]);
      }

      await sleep(pollIntervalMs);
    }

    const runtime: BenchmarkSessionRuntime | null = sessionId ? await client.getSession(sessionId).catch(() => null) : null;
    return finish("INVALID_RUN", [
      failure(
        "BENCHMARK_TIMEOUT",
        "workflow",
        `The benchmark did not reach frontend completion or a terminal blocking state within ${timeoutMs}ms.`,
        runtime?.latestTaskId ?? null,
      ),
    ]);
  } catch (error) {
    return finish("INVALID_RUN", [
      failure(
        "BENCHMARK_RUNNER_ERROR",
        "workflow",
        error instanceof Error ? error.message : String(error),
        taskIds.at(-1) ?? null,
      ),
    ]);
  }
}
