import type { BenchmarkSessionRuntime, BenchmarkWorkflowStatus } from "./borg-client.ts";

export type BenchmarkApprovalGate =
  | "project_plan"
  | "project_plan_revision"
  | "unknown"
  | null;

export interface BenchmarkObservation {
  at: string;
  taskId: string | null;
  taskState: string | null;
  runtimeActive: boolean;
  approvalGate: BenchmarkApprovalGate;
  workflowSource: string | null;
  stage: string | null;
  nextAction: string | null;
  sliceIndex: number | null;
  sliceTotal: number | null;
  sliceTitle: string | null;
}

export function approvalGate(runtime: BenchmarkSessionRuntime): BenchmarkApprovalGate {
  if (runtime.approval?.status !== "REQUESTED") return null;
  if (runtime.projectPlanApproval === true) return "project_plan";
  if (runtime.projectPlanRevisionApproval === true) return "project_plan_revision";
  return "unknown";
}

export function isFrontendComplete(status: BenchmarkWorkflowStatus) {
  if (status.phase !== "frontend") return false;
  if (status.status === "frontend_complete") return true;
  return status.taskState === "COMPLETE"
    && status.nextAction === "request_feedback"
    && status.run?.stage === "ready"
    && status.verificationPassed !== false;
}

export function isWorkflowFailure(status: BenchmarkWorkflowStatus) {
  return status.taskState === "FAILED" || status.taskState === "CANCELLED";
}

export function isWorkflowBlocked(status: BenchmarkWorkflowStatus) {
  return status.taskState === "BLOCKED"
    || status.taskState === "RECOVERY_REQUIRED"
    || status.run?.stage === "blocked"
    || status.run?.stage === "recovery_required"
    || status.run?.headline === "Visual baseline approval required";
}

export function observationFor(
  runtime: BenchmarkSessionRuntime,
  status: BenchmarkWorkflowStatus | null,
  at = new Date().toISOString(),
): BenchmarkObservation {
  return {
    at,
    taskId: runtime.latestTaskId,
    taskState: runtime.task?.state ?? null,
    runtimeActive: runtime.runtimeActive === true,
    approvalGate: approvalGate(runtime),
    workflowSource: status?.source ?? null,
    stage: status?.run?.stage ?? null,
    nextAction: status?.nextAction ?? null,
    sliceIndex: status?.sliceIndex ?? null,
    sliceTotal: status?.sliceTotal ?? null,
    sliceTitle: status?.sliceTitle ?? null,
  };
}
