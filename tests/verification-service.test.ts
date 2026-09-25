import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserEvidenceReport } from "../packages/browser-verification/src/index.ts";
import { selectSpecialistPacks } from "../packages/orchestration/src/index.ts";
import {
  findingsFromVerification,
  VerificationService,
  type VerificationOutcome,
  type VerificationServiceDependencies,
} from "../apps/server/src/verification-service.ts";

test("failed verification becomes actionable review findings", () => {
  const report = browserEvidence("task-findings", false);
  report.issues = ["2 enabled buttons have no observable action.", "1 serious accessibility violation was found."];
  report.accessibility = {
    incomplete: 0,
    passes: 10,
    violations: [{
      id: "color-contrast", impact: "serious", help: "Elements must meet minimum color contrast ratio thresholds",
      helpUrl: "https://dequeuniversity.com/rules/axe/color-contrast",
      nodes: [{ target: [".product-price"], html: "<span class=\"product-price\">$20</span>", failureSummary: "Contrast is 2.1:1." }],
    }],
  };
  const verification = {
    passed: false, results: [], browserEvidence: report, focusedBrowserRoute: null, focusedBrowserFailure: null,
    specialistEvidence: { passed: true, failures: [] }, specialistInstructions: "",
  } as unknown as VerificationOutcome;

  const findings = findingsFromVerification("task-findings", verification);
  assert.equal(findings.length, 2);
  assert.equal(findings[0].severity, "high");
  assert.match(findings[0].title, /Accessibility/);
  assert.match(findings[0].evidence ?? "", /product-price/);
  assert.match(findings[1].remediation ?? "", /working interaction/i);
});

function browserEvidence(taskId: string, passed = true): BrowserEvidenceReport {
  return {
    taskId,
    passed,
    issues: passed ? [] : ["Browser verification failed."],
    url: "http://127.0.0.1:5173/jobs",
    viewport: { width: 1440, height: 900 },
    capturedAt: new Date().toISOString(),
    dom: [],
    console: [],
    network: [],
    accessibility: null,
    screenshots: [],
    responsive: [],
    server: null,
  };
}

function serviceHarness(options?: {
  deterministic?: Record<string, unknown>;
  runningUrl?: string | null;
  closeReport?: BrowserEvidenceReport | null;
}) {
  const calls: string[] = [];
  const taskEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const emitted: Array<Record<string, unknown>> = [];
  const deterministic = options?.deterministic ?? { passed: true, results: [] };

  const deps = {
    tools: {
      execute: async (call: { function: { name: string } }) => {
        calls.push(call.function.name);
        if (call.function.name === "verification_run") return deterministic;
        if (call.function.name === "browser_responsive") return { passed: true };
        if (call.function.name === "browser_close") return { report: options?.closeReport ?? null };
        throw new Error(`Unexpected tool: ${call.function.name}`);
      },
    },
    processRuntime: {
      findRunning: () => options?.runningUrl ? { url: options.runningUrl } : null,
    },
  } as unknown as VerificationServiceDependencies;

  return {
    service: new VerificationService(deps),
    calls,
    taskEvents,
    emitted,
    emit: (event: Record<string, unknown>) => emitted.push(event),
    appendTaskEvent: (type: string, payload: Record<string, unknown>) => taskEvents.push({ type, payload }),
  };
}

test("VerificationService normalizes deterministic verification without owning workflow state", async () => {
  const h = serviceHarness({ deterministic: { passed: true, results: [{ label: "build", exitCode: 0 }] } });
  const result = await h.service.run({
    taskId: "task-backend",
    taskContext: { taskId: "task-backend", taskState: "VERIFYING", attemptPhase: null },
    activeDisciplines: ["backend"],
    packs: selectSpecialistPacks(["backend"]),
    verificationProfile: "quick",
    specialistInstructions: "Backend evidence rules",
    focusedScope: null,
    focusedBrowserRoute: null,
  }, h.emit, h.appendTaskEvent, 0);

  assert.equal(result.verification.passed, true);
  assert.equal(result.verification.specialistEvidence.passed, true);
  assert.match(result.summary, /quick verification passed/i);
  assert.match(result.resultSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(h.calls, ["verification_run"]);
  assert.equal(h.taskEvents.length, 0);
  assert.equal(h.emitted[0]?.type, "tool.started");
  assert.equal(h.emitted.at(-1)?.type, "tool.completed");
});

test("focused verification fails closed when the managed preview server is unavailable", async () => {
  const h = serviceHarness({ deterministic: { passed: true, results: [] }, runningUrl: null });
  const result = await h.service.run({
    taskId: "task-focused-missing-server",
    taskContext: { taskId: "task-focused-missing-server", taskState: "VERIFYING", attemptPhase: null },
    activeDisciplines: ["frontend"],
    packs: selectSpecialistPacks(["frontend"]),
    verificationProfile: "quick",
    specialistInstructions: "Frontend evidence rules",
    focusedScope: { type: "page", id: "jobs" },
    focusedBrowserRoute: "/jobs",
  }, h.emit, h.appendTaskEvent, 1);

  assert.equal(result.verification.passed, false);
  assert.match(result.verification.focusedBrowserFailure ?? "", /managed development server/i);
  assert.equal(result.verification.specialistEvidence.passed, false);
  assert.match(result.failure, /requires browser evidence/i);
  assert.deepEqual(h.calls, ["verification_run"]);
});

test("focused browser evidence can satisfy frontend specialist verification", async () => {
  const report = browserEvidence("task-focused-success");
  const h = serviceHarness({
    deterministic: { passed: true, results: [] },
    runningUrl: "http://127.0.0.1:5173",
    closeReport: report,
  });
  const result = await h.service.run({
    taskId: "task-focused-success",
    taskContext: { taskId: "task-focused-success", taskState: "VERIFYING", attemptPhase: null },
    activeDisciplines: ["frontend"],
    packs: selectSpecialistPacks(["frontend"]),
    verificationProfile: "quick",
    specialistInstructions: "Frontend evidence rules",
    focusedScope: { type: "page", id: "jobs" },
    focusedBrowserRoute: "/jobs",
  }, h.emit, h.appendTaskEvent, 0);

  assert.equal(result.verification.passed, true);
  assert.equal(result.verification.browserEvidence?.taskId, "task-focused-success");
  assert.equal(result.verification.focusedBrowserFailure, null);
  assert.equal(result.verification.specialistEvidence.passed, true);
  assert.deepEqual(h.calls, ["verification_run", "browser_responsive", "browser_close"]);
  assert.equal(h.taskEvents[0]?.type, "FOCUSED_BROWSER_VERIFICATION_COMPLETED");
  assert.equal(h.taskEvents[0]?.payload.route, "/jobs");
});
