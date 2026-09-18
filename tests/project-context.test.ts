import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compileFrontendContext } from "../packages/web-builder/src/context-compiler.ts";
import { readProjectModel, updateVerifiedProjectModel, writeProjectModel } from "../packages/web-builder/src/project-model.ts";
import { approveProjectPlan, fallbackProjectPlan, persistProposedProjectPlan, persistDesignBrief } from "../packages/web-builder/src/slice-docs.ts";
import { SqliteTaskRepository } from "../packages/persistence/src/sqlite-task-repository.ts";
import { createTask } from "../packages/core/src/contracts.ts";
import { deriveWorkflowStatus } from "../apps/server/src/workflow-status.ts";

test("approved website state yields scoped, durable context and registries", () => {
  const root = mkdtempSync(join(tmpdir(), "borg-project-context-"));
  try {
    mkdirSync(join(root, "src", "components"), { recursive: true });
    writeFileSync(join(root, "src", "components", "ProductCard.tsx"), "export function ProductCard() { return <article>Product</article>; }");
    writeFileSync(join(root, "src", "components", "UnrelatedChart.tsx"), "export function UnrelatedChart() { return <div>Chart</div>; }");
    const plan = fallbackProjectPlan("Build a product store", "ecommerce");
    persistProposedProjectPlan(root, "Build a product store", plan, "plan-task");
    approveProjectPlan(root, "plan-task");
    persistDesignBrief(root, { direction: "Warm product photography" });
    const model = readProjectModel(root);
    assert.ok(model.pages.length > 0);
    model.components.push({ id: "product-card", name: "Product Card", files: ["src/components/ProductCard.tsx"], usedBy: [], dependencies: [], variants: [], status: "planned", acceptanceCriteria: ["Card is responsive"] });
    writeProjectModel(root, model);
    const compiled = compileFrontendContext({ root, phase: "frontend", sliceIndex: 1, scope: { type: "component", id: "product-card" }, budgetCharacters: 12_000 });
    assert.match(compiled.text, /Build a product store/);
    assert.match(compiled.text, /ProductCard/);
    assert.doesNotMatch(compiled.text, /UnrelatedChart/);
    assert.ok(compiled.characters <= compiled.budgetCharacters);
    assert.ok(compiled.manifest.some((item) => item.path === "src/components/ProductCard.tsx" && item.reason.includes("Registered")));
    updateVerifiedProjectModel(root, ["src/components/ProductCard.tsx"]);
    assert.equal(readProjectModel(root).components.find((item) => item.id === "product-card")?.status, "verified");
    assert.equal(JSON.parse(readFileSync(join(root, ".localcode", "build", "pages.json"), "utf8")).version, 1);
    assert.throws(() => writeProjectModel(root, { ...model, components: [{ ...model.components[0], files: ["../outside.tsx"] }] }), /relative path|escapes/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("exact model input and manifest survive reopening the local task database", () => {
  const root = mkdtempSync(join(tmpdir(), "borg-model-context-"));
  const path = join(root, "tasks.sqlite");
  try {
    const first = new SqliteTaskRepository(path);
    first.saveTask(createTask({ id: "context-task", projectId: "local", request: "Build a store" }));
    first.saveModelContext({ id: "context-one", taskId: "context-task", role: "architect", model: "local-model", sliceId: "catalog", inputText: "{\"messages\":[\"exact\"]}", manifest: [{ path: "brief.md", reason: "project brief" }], inputSha256: "test-hash", createdAt: new Date().toISOString() });
    first.close();
    const reopened = new SqliteTaskRepository(path);
    assert.equal(reopened.listModelContexts("context-task").length, 1);
    assert.equal(reopened.findModelContext("context-task", "context-one")?.inputText, "{\"messages\":[\"exact\"]}");
    reopened.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("workflow status after restart follows durable failure and verification evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "borg-workflow-status-"));
  const path = join(root, "tasks.sqlite");
  try {
    const first = new SqliteTaskRepository(path);
    const task = { ...createTask({ id: "status-task", projectId: "local", request: "Build storefront" }), state: "FAILED" as const };
    first.saveTask(task);
    first.appendEvent({ id: "activity-one", taskId: task.id, type: "AGENT_ACTIVITY", payload: { activity: { title: "Running browser verification" } }, occurredAt: new Date().toISOString() });
    first.appendEvent({ id: "verification-one", taskId: task.id, type: "VERIFICATION_COMPLETED", payload: { verification: { passed: false } }, occurredAt: new Date().toISOString() });
    first.close();
    const reopened = new SqliteTaskRepository(path);
    const restored = deriveWorkflowStatus(reopened.findTask(task.id)!, reopened.listEvents(task.id), null, null);
    assert.equal(restored.currentAction, "failed");
    assert.equal(restored.verificationPassed, false);
    assert.match(restored.nextAction, /Inspect the failure/);
    assert.equal(restored.activity.length, 2);
    reopened.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("workflow status surfaces deterministic preflight and active recovery after restart", () => {
  const task = { ...createTask({ id: "recovery-status", projectId: "local", request: "Build checkout" }), state: "IMPLEMENTING" as const, attempts: 1 };
  const occurredAt = new Date().toISOString();
  const events = [
    {
      id: "preflight",
      taskId: task.id,
      type: "WORKSPACE_PREFLIGHT_COMPLETED",
      payload: {
        report: {
          passed: true,
          reason: "no_progress_recovery",
          contract: { kind: "vite-react" },
          repairedDirectories: ["src/features"],
          dependencyState: "configured",
          issues: [],
        },
      },
      occurredAt,
    },
    {
      id: "recovery",
      taskId: task.id,
      type: "IMPLEMENTATION_RECOVERY_SCHEDULED",
      payload: { attempt: 1, maximum: 2, category: "missing_path", reason: "ENOENT", action: "Retry the same slice." },
      occurredAt,
    },
  ];
  const status = deriveWorkflowStatus(task, events, null, null);
  assert.equal(status.recovery?.active, true);
  assert.equal(status.recovery?.category, "missing_path");
  assert.equal(status.preflight?.contract, "vite-react");
  assert.deepEqual(status.preflight?.repairedDirectories, ["src/features"]);
  assert.match(status.currentAction, /Recovery active/);
  assert.match(status.nextAction, /same approved slice/);
  assert.ok(status.activity.some((item) => /repaired 1 directory/.test(item.detail)));
});
