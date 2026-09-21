import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fallbackProjectPlan, type ProjectPlan } from "../packages/web-builder/src/slice-docs.ts";
import type { DesignReviewResult } from "../packages/design-intelligence/src/index.ts";
import {
  ProjectPlanRevisionService,
  type ProjectPlanRevisionServiceDependencies,
} from "../apps/server/src/project-plan-revision-service.ts";

function designReview(taskId: string): DesignReviewResult {
  return {
    taskId,
    status: "repair",
    repairScope: "project_plan",
    scopeReason: "The approved plan is missing an operational route.",
    summary: "Plan revision required.",
    dimensions: [],
    findings: [],
    provider: "ollama",
    model: "vision-test",
    reviewedAt: new Date().toISOString(),
    screenshots: [],
  };
}

function modelAnswer(plan: ProjectPlan) {
  return `<borg-project-plan>\n${JSON.stringify(plan)}\n</borg-project-plan>`;
}

test("ProjectPlanRevisionService generates a candidate without assigning Core revision authority", async () => {
  const current = {
    ...fallbackProjectPlan("Build an operations dashboard with jobs and customers.", "dashboard"),
    revision: 7,
    status: "approved" as const,
    approvedAt: new Date().toISOString(),
  };
  const candidate = fallbackProjectPlan("Build an operations dashboard with jobs and customers.", "dashboard");
  const calls: string[] = [];
  const deps = {
    ollamaUrl: "http://127.0.0.1:11434",
    runAgent: async () => {
      calls.push("agent");
      return { answer: modelAnswer(candidate), usedTools: false, budgetExhausted: false };
    },
  } as unknown as ProjectPlanRevisionServiceDependencies;
  const service = new ProjectPlanRevisionService(deps);

  const result = await service.generate({
    taskId: "revision-task",
    brief: "Build an operations dashboard with jobs and customers.",
    currentPlan: current,
    currentSliceIndex: 0,
    conflictReason: "Jobs require a dedicated operational route.",
    review: designReview("revision-task"),
    template: "dashboard",
    model: "architect-test",
    tools: {} as never,
    disciplines: ["frontend"],
    emit: () => undefined,
  });

  assert.equal(result.status, "candidate");
  if (result.status !== "candidate") return;
  assert.equal(calls.length, 1);
  assert.equal(result.semanticRetryUsed, false);
  assert.equal(result.candidate.revision, 1);
  assert.notEqual(result.candidate.revision, current.revision + 1);
});

test("ProjectPlanRevisionService performs one semantic retry and returns invalid instead of silently accepting fallback", async () => {
  let calls = 0;
  const current = {
    ...fallbackProjectPlan("Build an operations dashboard with jobs and customers.", "dashboard"),
    revision: 3,
    status: "approved" as const,
    approvedAt: new Date().toISOString(),
  };
  const taskEvents: string[] = [];
  const deps = {
    ollamaUrl: "http://127.0.0.1:11434",
    runAgent: async () => {
      calls += 1;
      return { answer: "No structured plan was returned.", usedTools: false, budgetExhausted: false };
    },
  } as unknown as ProjectPlanRevisionServiceDependencies;
  const service = new ProjectPlanRevisionService(deps);

  const result = await service.generate({
    taskId: "invalid-revision",
    brief: "Build an operations dashboard with jobs and customers.",
    currentPlan: current,
    currentSliceIndex: 0,
    conflictReason: "Plan repair required.",
    review: designReview("invalid-revision"),
    template: "dashboard",
    model: "architect-test",
    tools: {} as never,
    disciplines: ["frontend"],
    emit: () => undefined,
    appendTaskEvent: (type) => taskEvents.push(type),
  });

  assert.equal(result.status, "invalid");
  assert.equal(calls, 2);
  assert.equal(result.semanticRetryUsed, true);
  assert.ok(taskEvents.includes("PROJECT_PLAN_REVISION_SEMANTIC_RETRY"));
});

test("ProjectPlanRevisionService projects only the Core-authoritative proposed plan", () => {
  const root = mkdtempSync(join(tmpdir(), "borg-plan-revision-"));
  try {
    const previous = {
      ...fallbackProjectPlan("Build an operations dashboard.", "dashboard"),
      revision: 4,
      status: "approved" as const,
      approvedAt: new Date().toISOString(),
    };
    const authoritative = {
      ...fallbackProjectPlan("Build an operations dashboard.", "dashboard"),
      revision: 5,
      status: "proposed" as const,
      approvedAt: null,
    };
    const service = new ProjectPlanRevisionService({
      ollamaUrl: "http://127.0.0.1:11434",
      runAgent: async () => {
        throw new Error("generation is not part of projection");
      },
    });

    const result = service.persistAuthoritativeProjection({
      root,
      taskId: "projection-task",
      brief: "Build an operations dashboard.",
      previousPlan: previous,
      authoritativePlan: authoritative,
      resumeSliceIndex: 0,
      revisionReason: "Structural repair",
    });

    assert.equal(result.plan.revision, 5);
    assert.equal(result.plan.status, "proposed");
    assert.equal(result.coverage.valid, true);
    const planDoc = readFileSync(join(root, ".localcode", "build", "plan.md"), "utf8");
    assert.match(planDoc, /Revision: 5/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
