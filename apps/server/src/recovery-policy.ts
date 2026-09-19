import { RecoveryService, type RecoveryDecision } from "../../../packages/core/src/recovery-service.ts";
import type { WorkspacePreflightReport } from "../../../packages/web-builder/src/workspace-preflight.ts";

export type { RecoveryCategory, RecoveryDecision } from "../../../packages/core/src/recovery-service.ts";
const recovery = new RecoveryService();

export function classifyImplementationFailure(input: unknown, attempt: number, maximum: number, options: { noProgress?: boolean } = {}): RecoveryDecision {
  return recovery.classify(input, attempt, maximum, options);
}

export function compactRecoveryEvidence(decision: RecoveryDecision, preflight: WorkspacePreflightReport, recentFailures: readonly string[] = []): string {
  return recovery.compact(decision, preflight, recentFailures);
}
