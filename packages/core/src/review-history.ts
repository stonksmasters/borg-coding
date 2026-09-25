import { createHash, randomUUID } from "node:crypto";
import {
  FindingSchema,
  ReviewDecisionSchema,
  ReviewFindingOccurrenceSchema,
  ReviewFindingRecordSchema,
  type Finding,
  type ReviewDecision,
  type ReviewFindingRecord,
  type ReviewRun,
} from "./contracts.ts";

const activeStates = new Set<ReviewFindingRecord["state"]>(["open", "accepted", "reopened"]);
const operatorProtectedStates = new Set<ReviewFindingRecord["state"]>(["waived", "false_positive", "superseded"]);

function normalize(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replaceAll("\\", "/").replace(/\s+/g, " ");
}

export function findingFingerprint(finding: Finding): string {
  const value = FindingSchema.parse(finding);
  // Deliberately omit generated IDs and line numbers. Reviewers routinely move a
  // finding by a few lines after a repair; that must not manufacture a new issue.
  const identity = [value.discipline, value.category, value.file, value.title].map(normalize).join("\u0000");
  return createHash("sha256").update(identity).digest("hex");
}

export function stateForDecision(action: ReviewDecision["action"]): ReviewFindingRecord["state"] {
  return ({ accept: "accepted", mark_fixed: "fixed", waive: "waived", false_positive: "false_positive", reopen: "reopened", supersede: "superseded" } as const)[action];
}

export function validateReviewDecision(
  record: ReviewFindingRecord,
  input: Pick<ReviewDecision, "action" | "reason" | "evidence" | "actorType">,
): void {
  if (input.actorType !== "operator" && operatorProtectedStates.has(record.state)) {
    throw new Error("Only an operator may change a waived, false-positive, or superseded finding.");
  }
  if ((input.action === "waive" || input.action === "false_positive") && !input.reason.trim()) {
    throw new Error("Waiving or rejecting a finding requires a reason.");
  }
  if (input.action === "waive" && record.finding.severity === "critical") {
    throw new Error("Critical findings cannot be waived.");
  }
  if (input.action === "mark_fixed" && input.evidence.length === 0) {
    throw new Error("Marking a finding fixed requires verification evidence.");
  }
}

export function applyReviewDecision(record: ReviewFindingRecord, decision: ReviewDecision): ReviewFindingRecord {
  const parsed = ReviewDecisionSchema.parse(decision);
  if (parsed.findingId !== record.id || parsed.taskId !== record.taskId) throw new Error("Review decision does not belong to this finding.");
  if (parsed.resultingState !== stateForDecision(parsed.action)) throw new Error("Review decision state does not match its action.");
  validateReviewDecision(record, parsed);
  return ReviewFindingRecordSchema.parse({ ...record, state: parsed.resultingState });
}

export function reconcileReviewRun(input: {
  run: ReviewRun;
  incoming: Finding[];
  existing: ReviewFindingRecord[];
  resolutionEvidence?: string[];
  resolutionFilter?: (record: ReviewFindingRecord) => boolean;
  now?: string;
  idFactory?: () => string;
}): { records: ReviewFindingRecord[]; occurrences: ReturnType<typeof ReviewFindingOccurrenceSchema.parse>[]; decisions: ReviewDecision[] } {
  const now = input.now ?? new Date().toISOString();
  const id = input.idFactory ?? randomUUID;
  const records = new Map(input.existing.map((record) => [record.fingerprint, ReviewFindingRecordSchema.parse(record)]));
  const observed = new Set<string>();
  const occurrences: ReturnType<typeof ReviewFindingOccurrenceSchema.parse>[] = [];
  const decisions: ReviewDecision[] = [];

  for (const rawFinding of input.incoming) {
    const finding = FindingSchema.parse(rawFinding);
    if (finding.taskId !== input.run.taskId) throw new Error("Review finding does not belong to this review run.");
    const fingerprint = findingFingerprint(finding);
    observed.add(fingerprint);
    let record = records.get(fingerprint);
    if (!record) {
      record = ReviewFindingRecordSchema.parse({
        id: id(), taskId: input.run.taskId, fingerprint, firstSeenRunId: input.run.id,
        lastSeenRunId: input.run.id, state: "open", finding, firstSeenAt: now, lastSeenAt: now,
      });
    } else {
      const shouldReopen = record.state === "fixed";
      record = ReviewFindingRecordSchema.parse({ ...record, lastSeenRunId: input.run.id, lastSeenAt: now, finding: { ...finding, id: record.finding.id } });
      if (shouldReopen) {
        const decision = ReviewDecisionSchema.parse({
          id: id(), taskId: input.run.taskId, findingId: record.id, runId: input.run.id,
          checkpointId: input.run.checkpointId, continuationId: input.run.continuationId,
          action: "reopen", resultingState: "reopened", reason: "A verified-fixed finding was observed again.",
          evidence: [`Observed again in review run ${input.run.id}.`], actorType: "system", actorId: "review-reconciler", createdAt: now,
        });
        record = applyReviewDecision(record, decision);
        decisions.push(decision);
      }
    }
    records.set(fingerprint, record);
    occurrences.push(ReviewFindingOccurrenceSchema.parse({ id: id(), taskId: input.run.taskId, runId: input.run.id, findingId: record.id, finding, observedAt: now }));
  }

  if (input.resolutionEvidence?.length) {
    for (const [fingerprint, record] of records) {
      if (observed.has(fingerprint) || !activeStates.has(record.state) || record.lastSeenRunId === input.run.id || (input.resolutionFilter && !input.resolutionFilter(record))) continue;
      const decision = ReviewDecisionSchema.parse({
        id: id(), taskId: input.run.taskId, findingId: record.id, runId: input.run.id,
        checkpointId: input.run.checkpointId, continuationId: input.run.continuationId,
        action: "mark_fixed", resultingState: "fixed", reason: "The finding was not reproduced after a successful repair verification and fresh review.",
        evidence: input.resolutionEvidence, actorType: "system", actorId: "review-reconciler", createdAt: now,
      });
      records.set(fingerprint, applyReviewDecision(record, decision));
      decisions.push(decision);
    }
  }

  return { records: [...records.values()], occurrences, decisions };
}

export function blockingReviewFindings(records: ReviewFindingRecord[]): ReviewFindingRecord[] {
  return records.filter((record) => activeStates.has(record.state) && (record.finding.severity === "high" || record.finding.severity === "critical"));
}
