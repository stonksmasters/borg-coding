import type { FrontendAutonomyBenchmark } from "./contracts.ts";
import type { BenchmarkObservation } from "./observer.ts";
import type { BenchmarkFailure } from "./result.ts";
import type { BenchmarkDebugSnapshot } from "./borg-client.ts";
import type { BenchmarkViolationCode } from "./violations.ts";

export interface BenchmarkInvariantInput {
  benchmark: FrontendAutonomyBenchmark;
  observations: BenchmarkObservation[];
  snapshots: BenchmarkDebugSnapshot[];
  approvals: {
    projectPlan: number;
    projectPlanRevision: number;
  };
  completionClaimed: boolean;
}

function violation(
  code: BenchmarkViolationCode,
  category: BenchmarkFailure["category"],
  message: string,
  taskId: string | null = null,
  sliceId: string | null = null,
): BenchmarkFailure {
  return { code, category, message, taskId, sliceId };
}

function uniqueEvents(snapshots: BenchmarkDebugSnapshot[], sourceType: string) {
  const values = new Map<string, BenchmarkDebugSnapshot["events"][number]>();
  for (const snapshot of snapshots) {
    for (const event of snapshot.events) {
      if (event.sourceType === sourceType) values.set(event.id, event);
    }
  }
  return [...values.values()];
}

function snapshotForTask(snapshots: BenchmarkDebugSnapshot[], taskId: string | null) {
  if (!taskId) return null;
  return [...snapshots].reverse().find((snapshot) => snapshot.task.id === taskId) ?? null;
}

function sliceLabel(snapshot: BenchmarkDebugSnapshot | null, fallback: string | null = null) {
  if (!snapshot) return fallback;
  const title = snapshot.workflow?.sliceTitle;
  if (typeof title === "string" && title.trim()) return title;
  const index = snapshot.workflow?.sliceIndex;
  return typeof index === "number" ? `slice-${index + 1}` : fallback;
}

function workflowVerificationPassed(snapshot: BenchmarkDebugSnapshot | null) {
  return snapshot?.workflow?.verification?.status === "passed";
}

function preDeliveryCheckpoint(snapshot: BenchmarkDebugSnapshot | null) {
  if (!snapshot) return null;
  return [...snapshot.checkpoints].reverse().find((checkpoint) =>
    checkpoint.kind === "pre_delivery"
    && checkpoint.verification?.status === "passed"
    && ["DELIVERY_READY", "DELIVERING", "COMPLETE"].includes(checkpoint.taskState),
  ) ?? null;
}

function projectPlan(snapshot: BenchmarkDebugSnapshot | null) {
  const value = snapshot?.workflow?.projectPlan;
  return value && typeof value === "object" ? value : null;
}

export function evaluateBenchmarkInvariants(input: BenchmarkInvariantInput): BenchmarkFailure[] {
  const failures: BenchmarkFailure[] = [];
  const observedTaskIds = [...new Set(input.observations.map((item) => item.taskId).filter((value): value is string => Boolean(value)))];
  const snapshotTaskIds = new Set(input.snapshots.map((snapshot) => snapshot.task.id));

  if (input.completionClaimed) {
    for (const taskId of observedTaskIds) {
      if (!snapshotTaskIds.has(taskId)) {
        failures.push(violation(
          "AUTHORITATIVE_SNAPSHOT_MISSING",
          "workflow",
          `No read-only Core debug snapshot was captured for observed task ${taskId}; a passing benchmark cannot be proven from UI/session projection alone.`,
          taskId,
        ));
      }
    }
  }

  for (const observation of input.observations) {
    if (observation.workflowSource && observation.workflowSource !== "sqlite") {
      failures.push(violation(
        "WORKFLOW_SOURCE_NOT_SQLITE",
        "workflow",
        `Observed workflow source was ${observation.workflowSource}; benchmark progression must come from SQLite authority.`,
        observation.taskId,
        observation.sliceTitle,
      ));
    }
  }

  for (const snapshot of input.snapshots) {
    const activeSlice = typeof snapshot.workflow?.sliceIndex === "number";
    if (activeSlice) {
      const freshPlan = snapshot.events.find((event) => event.sourceType === "PROJECT_PLAN_PROPOSED");
      if (freshPlan) {
        const repair = snapshot.workflow?.attemptPhase === "technical_repair"
          || snapshot.workflow?.attemptPhase === "design_refinement"
          || (snapshot.workflow?.repairAttempt ?? 0) > 0
          || (snapshot.task.attempts ?? 0) > 0;
        failures.push(violation(
          repair ? "PROJECT_REPLANNED_DURING_SLICE_REPAIR" : "PROJECT_REPLANNED_DURING_SLICE_EXECUTION",
          "planning",
          repair
            ? "A fresh outer project plan was proposed while the active slice was in repair/refinement. Repair must remain inside the existing approved project plan unless Core requests a bounded plan revision."
            : "A fresh outer project plan was proposed after slice execution had begun. Slice execution must not restart project planning.",
          snapshot.task.id,
          sliceLabel(snapshot),
        ));
      }
    }

    for (const pack of snapshot.contextPacks) {
      const allowed = Math.min(pack.budgetCharacters, input.benchmark.limits.maxContextCharacters);
      if (pack.characters > allowed) {
        failures.push(violation(
          "CONTEXT_BUDGET_EXCEEDED",
          "context",
          `ContextPack ${pack.id} used ${pack.characters} characters, exceeding the allowed ${allowed} characters.`,
          snapshot.task.id,
          pack.sliceId ?? sliceLabel(snapshot),
        ));
      }
    }

    if (snapshot.approval?.status === "APPROVED" && snapshot.approval.worktreePath) {
      if (snapshot.git.worktreePath !== snapshot.approval.worktreePath || snapshot.git.worktreeExists === false) {
        failures.push(violation(
          "WORKTREE_AUTHORITY_VIOLATION",
          "workflow",
          "The approved mutation worktree is missing or does not match the worktree reported by the authoritative debug snapshot.",
          snapshot.task.id,
          sliceLabel(snapshot),
        ));
      }
    }

    const plan = projectPlan(snapshot);
    if (input.benchmark.expected.frontendOnly && plan?.backendRequired === true) {
      failures.push(violation(
        "BACKEND_REQUIRED_IN_FRONTEND_ONLY_BENCHMARK",
        "planning",
        "The durable project plan marked backend work as required for a frontend-only benchmark.",
        snapshot.task.id,
        sliceLabel(snapshot),
      ));
    }
  }

  const revisionEvents = uniqueEvents(input.snapshots, "PROJECT_PLAN_REVISION_PROPOSED");
  const revisionCount = Math.max(revisionEvents.length, input.approvals.projectPlanRevision);
  if (revisionCount > input.benchmark.limits.maxProjectPlanRevisions) {
    failures.push(violation(
      "PROJECT_PLAN_REVISION_LIMIT_EXCEEDED",
      "planning",
      `Observed ${revisionCount} project-plan revision(s); benchmark limit is ${input.benchmark.limits.maxProjectPlanRevisions}.`,
    ));
  }

  let previous: BenchmarkObservation | null = null;
  for (const current of input.observations) {
    if (current.sliceIndex === null) continue;
    if (previous?.sliceIndex !== null && previous?.sliceIndex !== undefined) {
      if (current.sliceIndex < previous.sliceIndex) {
        failures.push(violation(
          "SLICE_INDEX_REGRESSION",
          "progression",
          `Slice index regressed from ${previous.sliceIndex} to ${current.sliceIndex}.`,
          current.taskId,
          current.sliceTitle,
        ));
      } else if (current.sliceIndex > previous.sliceIndex + 1) {
        failures.push(violation(
          "SLICE_INDEX_JUMPED",
          "progression",
          `Slice index jumped from ${previous.sliceIndex} to ${current.sliceIndex}; Core must advance exactly one approved slice at a time.`,
          current.taskId,
          current.sliceTitle,
        ));
      } else if (current.sliceIndex === previous.sliceIndex + 1) {
        const priorSnapshot = snapshotForTask(input.snapshots, previous.taskId);
        const checkpoint = preDeliveryCheckpoint(priorSnapshot);
        if (!checkpoint) {
          failures.push(violation(
            "ADVANCED_WITHOUT_CHECKPOINT",
            "progression",
            `Workflow advanced from ${previous.sliceTitle ?? `slice ${previous.sliceIndex + 1}`} without a durable pre_delivery checkpoint carrying passed verification.`,
            previous.taskId,
            previous.sliceTitle,
          ));
        }
        if (!workflowVerificationPassed(priorSnapshot)) {
          failures.push(violation(
            "ADVANCED_WITHOUT_PASSED_VERIFICATION",
            "verification",
            `Workflow advanced from ${previous.sliceTitle ?? `slice ${previous.sliceIndex + 1}`} without a persisted passed verification gate.`,
            previous.taskId,
            previous.sliceTitle,
          ));
        }
      }
    }
    previous = current;
  }

  if (input.completionClaimed) {
    const finalObservation = [...input.observations].reverse().find((item) => item.sliceIndex !== null) ?? null;
    const finalSnapshot = snapshotForTask(input.snapshots, finalObservation?.taskId ?? null);
    if (finalSnapshot && !workflowVerificationPassed(finalSnapshot)) {
      failures.push(violation(
        "FRONTEND_COMPLETION_WITHOUT_PASSED_VERIFICATION",
        "completion",
        "Frontend completion was claimed without a persisted passed verification gate on the final slice.",
        finalSnapshot.task.id,
        sliceLabel(finalSnapshot, finalObservation?.sliceTitle ?? null),
      ));
    }

    const finalPlan = projectPlan(finalSnapshot);
    const sitemap = Array.isArray(finalPlan?.sitemap) ? finalPlan.sitemap as Array<{ route?: unknown }> : [];
    if (sitemap.length < input.benchmark.expected.minimumPages) {
      failures.push(violation(
        "FRONTEND_COMPLETION_BEFORE_MINIMUM_PAGES",
        "completion",
        `Frontend completion was claimed with ${sitemap.length} planned page(s); benchmark requires at least ${input.benchmark.expected.minimumPages}.`,
        finalSnapshot?.task.id ?? null,
      ));
    }
    const routes = new Set(sitemap.map((page) => typeof page.route === "string" ? page.route : "").filter(Boolean));
    for (const required of input.benchmark.expected.requiredRoutes) {
      if (!routes.has(required)) {
        failures.push(violation(
          "REQUIRED_ROUTE_MISSING",
          "completion",
          `Required benchmark route ${required} is missing from the durable project plan at frontend completion.`,
          finalSnapshot?.task.id ?? null,
        ));
      }
    }
  }

  const deduped = new Map<string, BenchmarkFailure>();
  for (const item of failures) {
    const key = [item.code, item.taskId ?? "", item.sliceId ?? "", item.message].join("::");
    deduped.set(key, item);
  }
  return [...deduped.values()];
}
