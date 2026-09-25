import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createReviewRun,
  createTask,
  type Finding,
  type ReviewDecision,
  type ReviewFindingRecord,
} from "../packages/core/src/contracts.ts";
import {
  applyReviewDecision,
  blockingReviewFindings,
  findingFingerprint,
  reconcileReviewRun,
  stateForDecision,
} from "../packages/core/src/review-history.ts";
import { SqliteTaskRepository } from "../packages/persistence/src/sqlite-task-repository.ts";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: overrides.id ?? "model-finding-1",
    taskId: overrides.taskId ?? "task-1",
    discipline: overrides.discipline ?? "backend",
    severity: overrides.severity ?? "high",
    category: overrides.category ?? "correctness",
    title: overrides.title ?? "Transaction can commit partial history",
    description: overrides.description ?? "A partial write can escape the transaction.",
    file: overrides.file ?? "src/history.ts",
    line: overrides.line ?? 42,
    evidence: overrides.evidence ?? "The decision insert occurs after COMMIT.",
    remediation: overrides.remediation ?? "Include all writes in one transaction.",
  };
}

function run(id: string, attempt = 0) {
  return createReviewRun({ id, taskId: "task-1", checkpointId: null, continuationId: null, attempt, status: "completed", verdict: "repair", summary: "Review complete.", completed: true });
}

function decision(record: ReviewFindingRecord, action: ReviewDecision["action"], input: Partial<ReviewDecision> = {}): ReviewDecision {
  return {
    id: input.id ?? `decision-${action}`,
    taskId: record.taskId,
    findingId: record.id,
    runId: input.runId ?? null,
    checkpointId: input.checkpointId ?? null,
    continuationId: input.continuationId ?? null,
    action,
    resultingState: stateForDecision(action),
    reason: input.reason ?? "Operator decision.",
    evidence: input.evidence ?? [],
    actorType: input.actorType ?? "operator",
    actorId: input.actorId ?? "operator-1",
    createdAt: input.createdAt ?? "2026-09-17T12:00:00.000Z",
  };
}

test("stable fingerprints deduplicate line drift and preserve one finding record", () => {
  assert.equal(findingFingerprint(finding({ line: 10, id: "a" })), findingFingerprint(finding({ line: 900, id: "b" })));
  const first = reconcileReviewRun({ run: run("run-1"), incoming: [finding({ line: 10 })], existing: [], now: "2026-09-17T10:00:00.000Z", idFactory: () => "record-1" });
  let sequence = 0;
  const second = reconcileReviewRun({ run: run("run-2", 1), incoming: [finding({ id: "new-model-id", line: 91 })], existing: first.records, now: "2026-09-17T11:00:00.000Z", idFactory: () => `generated-${++sequence}` });
  assert.equal(second.records.length, 1);
  assert.equal(second.records[0].id, "record-1");
  assert.equal(second.records[0].finding.line, 91);
  assert.equal(second.occurrences.length, 1);
});

test("an omitted finding is not silently fixed without verification evidence", () => {
  const first = reconcileReviewRun({ run: run("run-1"), incoming: [finding()], existing: [], idFactory: () => "record-1" });
  const second = reconcileReviewRun({ run: run("run-2"), incoming: [], existing: first.records, idFactory: () => "unused" });
  assert.equal(second.records[0].state, "open");
  assert.equal(second.decisions.length, 0);
});

test("successful repair evidence fixes an absent finding and recurrence reopens it", () => {
  let sequence = 0;
  const ids = () => `id-${++sequence}`;
  const first = reconcileReviewRun({ run: run("run-1"), incoming: [finding()], existing: [], idFactory: ids });
  const fixed = reconcileReviewRun({ run: run("run-2", 1), incoming: [], existing: first.records, resolutionEvidence: ["Verification passed.", "Fresh review did not reproduce it."], idFactory: ids });
  assert.equal(fixed.records[0].state, "fixed");
  assert.equal(fixed.decisions[0].action, "mark_fixed");
  const reopened = reconcileReviewRun({ run: run("run-3", 2), incoming: [finding({ line: 80 })], existing: fixed.records, idFactory: ids });
  assert.equal(reopened.records[0].state, "reopened");
  assert.equal(reopened.decisions[0].action, "reopen");
  assert.equal(blockingReviewFindings(reopened.records).length, 1);
});

test("scoped repair evidence only fixes findings owned by that verification phase", () => {
  let sequence = 0;
  const ids = () => `scoped-${++sequence}`;
  const verificationFinding = finding({ id: "verification", category: "verification/interaction", title: "Dead button" });
  const visualFinding = finding({ id: "visual", category: "design/hierarchy", title: "Weak hierarchy" });
  const first = reconcileReviewRun({ run: run("run-scope-1"), incoming: [verificationFinding, visualFinding], existing: [], idFactory: ids });
  const repaired = reconcileReviewRun({
    run: run("run-scope-2", 1), incoming: [], existing: first.records,
    resolutionEvidence: ["The next verification run did not reproduce this failure."],
    resolutionFilter: (record) => record.finding.category.startsWith("verification/"), idFactory: ids,
  });
  assert.equal(repaired.records.find((record) => record.finding.title === "Dead button")?.state, "fixed");
  assert.equal(repaired.records.find((record) => record.finding.title === "Weak hierarchy")?.state, "open");
});

test("waivers require reasons, critical findings cannot be waived, and system review cannot overwrite operator protection", () => {
  const record = reconcileReviewRun({ run: run("run-1"), incoming: [finding()], existing: [], idFactory: () => "record-1" }).records[0];
  assert.throws(() => applyReviewDecision(record, decision(record, "waive", { reason: "" })), /requires a reason/i);
  const critical = { ...record, finding: finding({ severity: "critical" }) };
  assert.throws(() => applyReviewDecision(critical, decision(critical, "waive")), /cannot be waived/i);
  const waived = applyReviewDecision(record, decision(record, "waive"));
  assert.throws(() => applyReviewDecision(waived, decision(waived, "reopen", { actorType: "reviewer" })), /Only an operator/i);
});

test("review runs, occurrences, records, and append-only decisions survive restart", () => {
  const root = mkdtempSync(join(tmpdir(), "borg-review-history-"));
  const database = join(root, "borg.db");
  try {
    const repository = new SqliteTaskRepository(database);
    repository.saveTask(createTask({ id: "task-1", projectId: "project-1", request: "Persist review decisions" }));
    const reviewRun = run("run-1");
    repository.saveReviewRun(reviewRun);
    let sequence = 0;
    const reconciled = reconcileReviewRun({ run: reviewRun, incoming: [finding()], existing: [], idFactory: () => `id-${++sequence}` });
    repository.saveReviewHistory(reconciled);
    const acceptedDecision = decision(reconciled.records[0], "accept", { id: "decision-1" });
    const accepted = applyReviewDecision(reconciled.records[0], acceptedDecision);
    repository.saveReviewHistory({ records: [accepted], decisions: [acceptedDecision] });
    assert.throws(() => repository.saveReviewHistory({ records: [accepted], decisions: [acceptedDecision] }), /UNIQUE/i);
    repository.close();

    const reopened = new SqliteTaskRepository(database);
    assert.deepEqual(reopened.listReviewRuns("task-1"), [reviewRun]);
    assert.equal(reopened.listReviewFindings("task-1")[0].state, "accepted");
    assert.equal(reopened.listReviewOccurrences("task-1").length, 1);
    assert.deepEqual(reopened.listReviewDecisions("task-1"), [acceptedDecision]);
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
