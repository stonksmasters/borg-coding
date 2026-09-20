import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveExecutionTaskScope,
  resolvePlanningTaskScope,
} from "../apps/server/src/task-scope-resolver.ts";

test("initial website work without an approved plan resolves to outer project planning", () => {
  const scope = resolvePlanningTaskScope({
    mode: "plan",
    rawSliceAction: "initial",
    hasWebsite: true,
    projectPlanStatus: null,
    previousSliceStatus: null,
    hasPreviousSlice: false,
    durableHasProjectPlan: false,
  });

  assert.equal(scope.kind, "project_plan");
  assert.equal(scope.projectPlanning, true);
  assert.equal(scope.slicedApplication, false);
  assert.equal(scope.miniLoop, false);
  assert.equal(scope.workflowIntent, "project_plan");
  assert.equal(scope.workflowCommandId, null);
  assert.match(scope.workflowDetail, /requested project work/i);
});

test("a proposed plan remains in project planning until approval", () => {
  const scope = resolvePlanningTaskScope({
    mode: "edit",
    rawSliceAction: "initial",
    hasWebsite: true,
    projectPlanStatus: "proposed",
    previousSliceStatus: "plan_pending",
    hasPreviousSlice: true,
    durableHasProjectPlan: true,
  });

  assert.equal(scope.kind, "project_plan");
  assert.equal(scope.projectPlanning, true);
  assert.equal(scope.workflowIntent, "project_plan");
});

test("approved slice start consumes the Core start_slice command instead of choosing a slice locally", () => {
  const scope = resolvePlanningTaskScope({
    mode: "edit",
    rawSliceAction: "initial",
    hasWebsite: true,
    projectPlanStatus: "approved",
    previousSliceStatus: "ready",
    hasPreviousSlice: true,
    durableHasProjectPlan: true,
    pendingCommand: { id: "start-command", action: "start_slice" },
  });

  assert.equal(scope.kind, "frontend_slice");
  assert.equal(scope.slicedApplication, true);
  assert.equal(scope.miniLoop, true);
  assert.equal(scope.sliceAction, "initial");
  assert.equal(scope.expectedCommandAction, "start_slice");
  assert.equal(scope.workflowCommandId, "start-command");
  assert.equal(scope.workflowIntent, "frontend_slice");
  assert.match(scope.workflowDetail, /without repository rediscovery/i);
});

test("approved slice advance consumes the Core advance_slice command", () => {
  const scope = resolvePlanningTaskScope({
    mode: "agent",
    rawSliceAction: "advance",
    hasWebsite: true,
    projectPlanStatus: "approved",
    previousSliceStatus: "awaiting_feedback",
    hasPreviousSlice: true,
    durableHasProjectPlan: true,
    pendingCommand: { id: "advance-command", action: "advance_slice" },
  });

  assert.equal(scope.kind, "frontend_slice");
  assert.equal(scope.sliceAction, "advance");
  assert.equal(scope.expectedCommandAction, "advance_slice");
  assert.equal(scope.workflowCommandId, "advance-command");
});

test("explicit workflow command remains a transport override without changing the expected Core action", () => {
  const scope = resolvePlanningTaskScope({
    mode: "edit",
    rawSliceAction: "initial",
    hasWebsite: true,
    projectPlanStatus: "approved",
    previousSliceStatus: "ready",
    hasPreviousSlice: true,
    durableHasProjectPlan: true,
    pendingCommand: { id: "stale-command", action: "repair" },
    explicitWorkflowCommandId: "explicit-start-command",
  });

  assert.equal(scope.expectedCommandAction, "start_slice");
  assert.equal(scope.workflowCommandId, "explicit-start-command");
});

test("approved slice start and advance fail closed when Core has no matching pending command", () => {
  assert.throws(
    () => resolvePlanningTaskScope({
      mode: "edit",
      rawSliceAction: "initial",
      hasWebsite: true,
      projectPlanStatus: "approved",
      previousSliceStatus: "ready",
      hasPreviousSlice: true,
      durableHasProjectPlan: true,
      pendingCommand: null,
    }),
    /Core has no pending start_slice command/i,
  );

  assert.throws(
    () => resolvePlanningTaskScope({
      mode: "edit",
      rawSliceAction: "advance",
      hasWebsite: true,
      projectPlanStatus: "approved",
      previousSliceStatus: "awaiting_feedback",
      hasPreviousSlice: true,
      durableHasProjectPlan: true,
      pendingCommand: { id: "wrong-command", action: "start_slice" },
    }),
    /Core has no pending advance_slice command/i,
  );
});

test("slice revise stays inside the approved frontend mini-loop without inventing a Core advance command", () => {
  const scope = resolvePlanningTaskScope({
    mode: "edit",
    rawSliceAction: "revise",
    hasWebsite: true,
    projectPlanStatus: "approved",
    previousSliceStatus: "awaiting_feedback",
    hasPreviousSlice: true,
    durableHasProjectPlan: true,
  });

  assert.equal(scope.kind, "frontend_slice");
  assert.equal(scope.sliceAction, "revise");
  assert.equal(scope.expectedCommandAction, null);
  assert.equal(scope.workflowCommandId, null);
});

test("focused page and component work require an approved plan and durable scope id", () => {
  assert.throws(
    () => resolvePlanningTaskScope({
      mode: "edit",
      rawSliceAction: "page",
      scopeId: "home",
      hasWebsite: true,
      projectPlanStatus: "proposed",
      previousSliceStatus: "plan_pending",
      hasPreviousSlice: true,
      durableHasProjectPlan: true,
    }),
    /Approve the website plan/i,
  );

  assert.throws(
    () => resolvePlanningTaskScope({
      mode: "edit",
      rawSliceAction: "component",
      scopeId: " ",
      hasWebsite: true,
      projectPlanStatus: "approved",
      previousSliceStatus: "ready",
      hasPreviousSlice: true,
      durableHasProjectPlan: true,
    }),
    /component workspace is missing its durable scope id/i,
  );

  const page = resolvePlanningTaskScope({
    mode: "edit",
    rawSliceAction: "page",
    scopeId: "jobs",
    hasWebsite: true,
    projectPlanStatus: "approved",
    previousSliceStatus: "ready",
    hasPreviousSlice: true,
    durableHasProjectPlan: true,
  });
  assert.equal(page.kind, "focused_page");
  assert.deepEqual(page.focus, { type: "page", id: "jobs" });
  assert.equal(page.miniLoop, true);
  assert.match(page.workflowDetail, /focused page edit/i);

  const component = resolvePlanningTaskScope({
    mode: "edit",
    rawSliceAction: "component",
    scopeId: "job-table",
    hasWebsite: true,
    projectPlanStatus: "approved",
    previousSliceStatus: "ready",
    hasPreviousSlice: true,
    durableHasProjectPlan: true,
  });
  assert.equal(component.kind, "focused_component");
  assert.deepEqual(component.focus, { type: "component", id: "job-table" });
});

test("global styles workspace requires the approved plan but does not advance the main slice", () => {
  const scope = resolvePlanningTaskScope({
    mode: "edit",
    rawSliceAction: "style",
    hasWebsite: true,
    projectPlanStatus: "approved",
    previousSliceStatus: "ready",
    hasPreviousSlice: true,
    durableHasProjectPlan: true,
  });

  assert.equal(scope.kind, "global_styles");
  assert.equal(scope.styleFocus, true);
  assert.equal(scope.miniLoop, true);
  assert.equal(scope.slicedApplication, false);
  assert.equal(scope.workflowIntent, "general");
  assert.match(scope.workflowDetail, /global style edit/i);
});

test("backend work remains an explicit backend workflow intent", () => {
  const scope = resolvePlanningTaskScope({
    mode: "edit",
    rawSliceAction: "backend",
    hasWebsite: true,
    projectPlanStatus: "approved",
    previousSliceStatus: "frontend_complete",
    hasPreviousSlice: true,
    durableHasProjectPlan: true,
  });

  assert.equal(scope.kind, "backend");
  assert.equal(scope.workflowIntent, "backend");
  assert.equal(scope.miniLoop, false);
});

test("ASK and general requests do not accidentally enter mutation mini-loops", () => {
  const ask = resolvePlanningTaskScope({
    mode: "ask",
    rawSliceAction: "initial",
    hasWebsite: true,
    projectPlanStatus: "approved",
    previousSliceStatus: "ready",
    hasPreviousSlice: true,
    durableHasProjectPlan: true,
    pendingCommand: { id: "start-command", action: "start_slice" },
  });
  assert.equal(ask.kind, "ask");
  assert.equal(ask.slicedApplication, false);
  assert.equal(ask.miniLoop, false);
  assert.equal(ask.workflowIntent, "general");

  const general = resolvePlanningTaskScope({
    mode: "edit",
    rawSliceAction: "initial",
    hasWebsite: false,
    projectPlanStatus: null,
    previousSliceStatus: null,
    hasPreviousSlice: false,
    durableHasProjectPlan: false,
  });
  assert.equal(general.kind, "general");
  assert.equal(general.workflowIntent, "general");
});

test("blocked-task retry is rejected from chat so continuation remains the only recovery entry point", () => {
  assert.throws(
    () => resolvePlanningTaskScope({
      mode: "edit",
      rawSliceAction: "retry",
      hasWebsite: true,
      projectPlanStatus: "approved",
      previousSliceStatus: "ready",
      hasPreviousSlice: true,
      durableHasProjectPlan: true,
    }),
    /existing task continuation endpoint/i,
  );
});

test("execution scope restores focused workspace authority from persisted task events", () => {
  const page = resolveExecutionTaskScope({
    events: [
      { type: "FRONTEND_SLICE_SELECTED", payload: { action: "initial" } },
      { type: "FOCUSED_WORKSPACE_SELECTED", payload: { scopeType: "page", scopeId: "customers" } },
    ],
    hasWebsite: true,
    hasProjectPlan: true,
    hasSliceState: true,
    priorDeliveredWebsiteTask: true,
  });

  assert.equal(page.kind, "focused_page");
  assert.deepEqual(page.focus, { type: "page", id: "customers" });
  assert.equal(page.websiteWorkflow, "iterative_edit");
});

test("execution scope distinguishes style, frontend slice, backend, and general work without choosing progression", () => {
  const styles = resolveExecutionTaskScope({
    events: [{ type: "STYLE_WORKSPACE_SELECTED", payload: { scope: "global" } }],
    hasWebsite: true,
    hasProjectPlan: true,
    hasSliceState: true,
    priorDeliveredWebsiteTask: true,
  });
  assert.equal(styles.kind, "global_styles");
  assert.equal(styles.websiteWorkflow, "iterative_edit");

  const slice = resolveExecutionTaskScope({
    events: [{ type: "FRONTEND_SLICE_SELECTED", payload: { action: "initial" } }],
    hasWebsite: true,
    hasProjectPlan: true,
    hasSliceState: true,
    priorDeliveredWebsiteTask: false,
  });
  assert.equal(slice.kind, "frontend_slice");
  assert.equal(slice.websiteWorkflow, "initial_generation");

  const backend = resolveExecutionTaskScope({
    events: [{ type: "BACKEND_PHASE_SELECTED", payload: {} }],
    hasWebsite: true,
    hasProjectPlan: true,
    hasSliceState: false,
    priorDeliveredWebsiteTask: true,
  });
  assert.equal(backend.kind, "backend");
  assert.equal(backend.websiteWorkflow, "iterative_edit");

  const general = resolveExecutionTaskScope({
    events: [],
    hasWebsite: false,
    hasProjectPlan: false,
    hasSliceState: false,
    priorDeliveredWebsiteTask: false,
  });
  assert.equal(general.kind, "general");
  assert.equal(general.websiteWorkflow, "initial_generation");
});
