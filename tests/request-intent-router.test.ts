import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowState } from "../packages/core/src/contracts.ts";
import type { ProjectModel } from "../packages/web-builder/src/project-model.ts";
import { routeRequestIntent } from "../apps/server/src/request-intent-router.ts";

const workflow = {
  projectPlan: { status: "approved" },
  sliceIndex: 0,
  status: "awaiting_feedback",
  pendingCommand: { id: "start-command", action: "start_slice" },
} as unknown as WorkflowState;

const model: ProjectModel = {
  pages: [{ id: "home", name: "Home", route: "/", purpose: "", sections: [], files: [], components: ["hero"], status: "verified", acceptanceCriteria: [] }],
  components: [{ id: "hero", name: "Hero", kind: "section", purpose: "", usedBy: ["home"], variants: [], acceptanceCriteria: [], files: [], dependencies: [], status: "verified" }],
};

test("selected component takes precedence over incidental names and polite requests remain edits", () => {
  for (const request of ["Can you make this button larger?", "Could you update the Home link label?"]) {
    const result = routeRequestIntent({ request, mode: "edit", requestedSliceAction: "initial", workflow, projectModel: model, currentFocus: { type: "component", id: "hero" } });
    assert.equal(result.intent, "focused_component");
    assert.equal(result.scope?.id, "hero");
  }
  const ask = routeRequestIntent({ request: "Can you make this button larger?", mode: "ask", requestedSliceAction: "initial", workflow, projectModel: model });
  assert.equal(ask.intent, "question");
});

test("normal chat proposes a quick edit without consuming a pending start_slice command", () => {
  const result = routeRequestIntent({ request: "Make the CTA smaller.", mode: "edit", requestedSliceAction: "initial", workflow, projectModel: model });
  assert.equal(result.intent, "quick_edit");
  assert.equal(result.impact, "local");
  assert.equal(result.routedSliceAction, "quick_edit");
});

test("an explicit workflow command remains a workflow command", () => {
  const result = routeRequestIntent({ request: "Start the approved slice.", mode: "agent", requestedSliceAction: "initial", explicitWorkflowCommandId: "start-command", workflow, projectModel: model });
  assert.equal(result.intent, "workflow_command");
  assert.equal(result.routedSliceAction, "initial");
});

test("known components and pages produce focused scope proposals", () => {
  const component = routeRequestIntent({ request: "Make the Hero less empty.", mode: "edit", requestedSliceAction: "initial", workflow, projectModel: model });
  assert.equal(component.intent, "focused_component");
  assert.deepEqual(component.scope, { type: "component", id: "hero" });

  const page = routeRequestIntent({ request: "Improve the Home page.", mode: "edit", requestedSliceAction: "initial", workflow, projectModel: model });
  assert.equal(page.intent, "focused_page");
  assert.deepEqual(page.scope, { type: "page", id: "home" });
});

test("global style and structural requests cannot silently become quick edits", () => {
  const styles = routeRequestIntent({ request: "Change the whole site to navy and cream.", mode: "edit", requestedSliceAction: "initial", workflow, projectModel: model });
  assert.equal(styles.intent, "global_styles");
  assert.equal(styles.impact, "global");

  const structural = routeRequestIntent({ request: "Add a pricing page.", mode: "edit", requestedSliceAction: "initial", workflow, projectModel: model });
  assert.equal(structural.intent, "structural_change");
  assert.equal(structural.impact, "structural");
  assert.equal(structural.requiresPlanRevision, true);
});

test("questions and current-slice feedback are distinguished", () => {
  const question = routeRequestIntent({ request: "How does authentication work?", mode: "edit", requestedSliceAction: "initial", workflow, projectModel: model });
  assert.equal(question.intent, "question");

  const feedback = routeRequestIntent({ request: "The hero you just built is too empty.", mode: "edit", requestedSliceAction: "initial", workflow, projectModel: model });
  assert.equal(feedback.intent, "slice_feedback");
  assert.equal(feedback.routedSliceAction, "revise");
});

test("explicit Page, Component, Styles, and Backend workspaces keep their authority", () => {
  for (const [action, intent] of [["page", "focused_page"], ["component", "focused_component"], ["style", "global_styles"], ["backend", "backend_change"]] as const) {
    const result = routeRequestIntent({ request: "Make the requested change.", mode: "edit", requestedSliceAction: action, requestedScopeId: action === "page" ? "home" : action === "component" ? "hero" : null, workflow, projectModel: model });
    assert.equal(result.intent, intent);
  }
});

test("a broad new-website brief stays in initial planning even when it describes global styles and pages", () => {
  const result = routeRequestIntent({
    request: "Create a complete website from scratch. Pages: Observation Map and Field Guide. Use a global design system with an ocean color palette and typography.",
    mode: "plan",
    requestedSliceAction: "initial",
    workflow: null,
    projectModel: null,
  });
  assert.equal(result.intent, "structural_change");
  assert.equal(result.routedSliceAction, "initial");
  assert.equal(result.requiresPlanRevision, false);
});
