import { RecoveryService, type RecoveryDecision } from "../../../packages/core/src/recovery-service.ts";
import type { WorkspacePreflightReport } from "../../../packages/web-builder/src/workspace-preflight.ts";

export type { RecoveryCategory, RecoveryDecision } from "../../../packages/core/src/recovery-service.ts";
const recovery = new RecoveryService();

export function classifyImplementationFailure(input: unknown, attempt: number, maximum: number, options: { noProgress?: boolean } = {}): RecoveryDecision {
  return recovery.classify(input, attempt, maximum, options);
}

export function classifyObservedToolFailures(
  failures: readonly string[],
  attempt: number,
  maximum: number,
  fallback: string,
): RecoveryDecision {
  const observed = failures.map((failure) => recovery.classify(failure, attempt, maximum));
  const knownFatal = observed.find((decision) =>
    decision.disposition === "fatal"
    && decision.category !== "unknown"
    && decision.category !== "retry_exhausted");
  if (knownFatal) return knownFatal;

  const retryable = observed.find((decision) => decision.disposition === "retry");
  if (retryable) return retryable;

  if (attempt >= maximum && failures.length) {
    return recovery.classify(failures.at(-1)!, attempt, maximum);
  }
  return recovery.classify(fallback, attempt, maximum, { noProgress: true });
}

export function compactRecoveryEvidence(decision: RecoveryDecision, preflight: WorkspacePreflightReport, recentFailures: readonly string[] = []): string {
  return recovery.compact(decision, preflight, recentFailures);
}
