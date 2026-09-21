import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserEvidenceReport } from "../packages/browser-verification/src/index.ts";
import type { DesignBrief, DesignReviewResult } from "../packages/design-intelligence/src/index.ts";
import { fallbackProjectPlan } from "../packages/web-builder/src/slice-docs.ts";
import {
  QualityGateService,
  type QualityGateServiceDependencies,
} from "../apps/server/src/quality-gate-service.ts";

function evidence(taskId: string): BrowserEvidenceReport {
  return {
    taskId,
    passed: true,
    issues: [],
    url: "http://127.0.0.1:5173/",
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

function designBrief(taskId: string): DesignBrief {
  return {
    taskId,
    createdAt: new Date().toISOString(),
    audience: "Operators",
    primaryPromise: "Clear operational control",
    brandCharacter: ["focused", "premium", "credible"],
    visualDirection: "Dense but calm operational interface.",
    typography: { display: "Strong", body: "Readable", hierarchy: "Clear" },
    palette: [
      { role: "surface", direction: "neutral" },
      { role: "text", direction: "high contrast" },
      { role: "accent", direction: "restrained" },
    ],
    sections: [
      { purpose: "Overview", composition: "dashboard", visualWeight: "high-impact" },
      { purpose: "Work", composition: "table", visualWeight: "balanced" },
      { purpose: "Details", composition: "panel", visualWeight: "quiet" },
    ],
    motion: [],
    mobileStrategy: ["prioritize tasks", "collapse secondary controls"],
    contentVoice: ["direct", "specific"],
    avoid: ["generic cards", "fake metrics", "excessive pills", "weak hierarchy", "decorative gradients"],
    qualityBar: ["clear hierarchy", "responsive", "accessible", "credible", "coherent"],
  };
}

function review(taskId: string, scope: DesignReviewResult["repairScope"], status: DesignReviewResult["status"] = "repair"): DesignReviewResult {
  return {
    taskId,
    status,
    repairScope: scope,
    scopeReason: scope === "current_slice" ? "The current slice can fix this." : "The approved slice boundary is insufficient.",
    summary: "Quality review result.",
    dimensions: [],
    findings: [],
    provider: "ollama",
    model: "vision-test",
    reviewedAt: new Date().toISOString(),
    screenshots: [],
  };
}

function serviceWithDesign(result: DesignReviewResult) {
  const deps = {
    vision: {
      status: () => ({ provider: "ollama", model: "vision-test" }),
      review: async () => {
        throw new Error("legacy vision should not run when a Design Brief exists");
      },
    },
    visualDirector: {
      review: async () => result,
    },
    ollamaUrl: "http://127.0.0.1:11434",
    runReview: async () => ({
      verdict: "pass" as const,
      summary: "Pass",
      criteria: [],
      findings: [],
    }),
  } as unknown as QualityGateServiceDependencies;
  return new QualityGateService(deps);
}

test("QualityGateService keeps current-slice Visual Director repair bounded", async () => {
  const taskId = "quality-current-slice";
  const service = serviceWithDesign(review(taskId, "current_slice"));
  const plan = fallbackProjectPlan("Build an operations dashboard.", "dashboard");
  const result = await service.evaluateVisual({
    taskId,
    request: "Build the dashboard",
    worktreePath: ".",
    browserEvidence: evidence(taskId),
    designBrief: designBrief(taskId),
    activeSlicePrompt: "Current slice",
    projectPlan: plan,
    sliceState: {
      version: 2,
      current: 0,
      total: plan.slices.length,
      currentTitle: plan.slices[0].title,
      status: "working",
      brief: plan.siteGoal,
      lastTaskId: taskId,
      feedback: [],
      planRevision: plan.revision,
      backendRequired: plan.backendRequired,
    },
    attempt: 0,
    emit: () => undefined,
    appendTaskEvent: () => undefined,
  });

  assert.equal(result.action, "repair_current_slice");
  if (result.action !== "repair_current_slice") return;
  assert.equal(result.source, "visual_director");
  assert.match(result.repairEvidence, /CURRENT-SLICE REFINEMENT REQUIRED/);
});

test("QualityGateService escalates cross-slice Visual Director repair without mutating workflow", async () => {
  const taskId = "quality-cross-slice";
  const service = serviceWithDesign(review(taskId, "cross_slice"));
  const plan = fallbackProjectPlan("Build an operations dashboard.", "dashboard");
  const result = await service.evaluateVisual({
    taskId,
    request: "Build the dashboard",
    worktreePath: ".",
    browserEvidence: evidence(taskId),
    designBrief: designBrief(taskId),
    activeSlicePrompt: "Current slice",
    projectPlan: plan,
    sliceState: {
      version: 2,
      current: 0,
      total: plan.slices.length,
      currentTitle: plan.slices[0].title,
      status: "working",
      brief: plan.siteGoal,
      lastTaskId: taskId,
      feedback: [],
      planRevision: plan.revision,
      backendRequired: plan.backendRequired,
    },
    attempt: 0,
    emit: () => undefined,
    appendTaskEvent: () => undefined,
  });

  assert.equal(result.action, "revise_project_plan");
  if (result.action !== "revise_project_plan") return;
  assert.equal(result.scope, "cross_slice");
  assert.match(result.reason, /slice boundary is insufficient/i);
});

test("QualityGateService blocks mandatory design review without browser evidence", async () => {
  const taskId = "quality-no-browser";
  const service = serviceWithDesign(review(taskId, "none", "pass"));
  const result = await service.evaluateVisual({
    taskId,
    request: "Build the dashboard",
    worktreePath: ".",
    browserEvidence: null,
    designBrief: designBrief(taskId),
    activeSlicePrompt: "",
    projectPlan: null,
    sliceState: null,
    attempt: 0,
    emit: () => undefined,
    appendTaskEvent: () => undefined,
  });

  assert.equal(result.action, "block");
  if (result.action !== "block") return;
  assert.match(result.reason, /responsive browser evidence is missing/i);
});

test("QualityGateService normalizes fresh-review failure as current-slice repair", async () => {
  const deps = {
    vision: {},
    visualDirector: {},
    ollamaUrl: "http://127.0.0.1:11434",
    runReview: async () => ({
      verdict: "repair" as const,
      summary: "Acceptance criterion is not proven.",
      criteria: [{ criterion: "Jobs route works", verdict: "not_proven" as const, evidence: "No evidence." }],
      findings: [],
    }),
  } as unknown as QualityGateServiceDependencies;
  const service = new QualityGateService(deps);
  const plan = fallbackProjectPlan("Build an operations dashboard.", "dashboard");
  const result = await service.evaluateFreshReview({
    taskId: "fresh-review",
    request: "Build the dashboard",
    projectPlan: plan,
    sliceState: null,
    focusedScope: null,
    styleWorkspace: false,
    implementationBudgetExhausted: false,
    diff: "diff --git a/src/App.tsx b/src/App.tsx",
    verification: { passed: true },
    reviewerModel: "reviewer-test",
    specialistInstructions: "Review carefully.",
  });

  assert.equal(result.action, "repair_current_slice");
  if (result.action !== "repair_current_slice") return;
  assert.equal(result.source, "fresh_review");
  assert.match(result.repairEvidence, /Fresh-context review requires repair/);
});
