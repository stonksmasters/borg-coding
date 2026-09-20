import type { PermissionMode } from "../../../packages/core/src/chat-session.ts";
import type { WorkflowCommand } from "../../../packages/core/src/contracts.ts";
import type { ProjectPlan, SliceAction, SliceState } from "../../../packages/web-builder/src/slice-docs.ts";
import type { WebsiteWorkflowKind } from "../../../packages/web-builder/src/generation-context.ts";

export type PlanningTaskKind =
  | "ask"
  | "project_plan"
  | "frontend_slice"
  | "focused_page"
  | "focused_component"
  | "global_styles"
  | "backend"
  | "general";

export type FocusedScope = {
  type: "page" | "component";
  id: string;
};

export type PlanningTaskScope = {
  kind: PlanningTaskKind;
  rawSliceAction: string;
  sliceAction: SliceAction;
  projectPlanning: boolean;
  slicedApplication: boolean;
  miniLoop: boolean;
  styleFocus: boolean;
  focus: FocusedScope | null;
  expectedCommandAction: "start_slice" | "advance_slice" | null;
  workflowCommandId: string | null;
  workflowIntent: "project_plan" | "backend" | "general" | "frontend_slice";
  workflowDetail: string;
};

export type PlanningTaskScopeInput = {
  mode: PermissionMode;
  rawSliceAction: string;
  scopeId?: string | null;
  hasWebsite: boolean;
  projectPlanStatus?: ProjectPlan["status"] | null;
  previousSliceStatus?: SliceState["status"] | null;
  hasPreviousSlice: boolean;
  durableHasProjectPlan: boolean;
  pendingCommand?: Pick<WorkflowCommand, "id" | "action"> | null;
  explicitWorkflowCommandId?: string | null;
};

function normalizeId(value: string | null | undefined) {
  return String(value ?? "").trim();
}

export function resolvePlanningTaskScope(input: PlanningTaskScopeInput): PlanningTaskScope {
  const rawSliceAction = input.rawSliceAction;
  if (rawSliceAction === "retry") {
    throw new Error("Blocked tasks must be retried through their existing task continuation endpoint.");
  }

  const projectPlanning = input.mode !== "ask"
    && rawSliceAction === "initial"
    && input.hasWebsite
    && (!input.projectPlanStatus || input.projectPlanStatus === "proposed")
    && input.previousSliceStatus !== "ready";

  const focusedPlanReady = input.hasWebsite
    && Boolean(input.projectPlanStatus)
    && input.projectPlanStatus !== "proposed";

  if (input.mode !== "ask" && ["style", "page", "component"].includes(rawSliceAction) && !focusedPlanReady) {
    throw new Error("Approve the website plan before starting a focused Page, Component, or Styles workspace.");
  }

  const styleFocus = input.mode !== "ask" && rawSliceAction === "style" && focusedPlanReady;
  const focusType = rawSliceAction === "page" || rawSliceAction === "component"
    ? rawSliceAction as FocusedScope["type"]
    : null;
  const focusId = focusType ? normalizeId(input.scopeId) : "";
  if (focusType && !focusId) throw new Error(`${focusType} workspace is missing its durable scope id.`);
  const focus = input.mode !== "ask" && focusType && focusId && focusedPlanReady
    ? { type: focusType, id: focusId } as FocusedScope
    : null;

  const slicedApplication = input.mode !== "ask"
    && !["backend", "style", "page", "component"].includes(rawSliceAction)
    && input.hasWebsite
    && input.projectPlanStatus === "approved"
    && input.hasPreviousSlice;

  const miniLoop = slicedApplication || styleFocus || Boolean(focus);
  const sliceAction: SliceAction = rawSliceAction === "advance" || rawSliceAction === "revise"
    ? rawSliceAction
    : "initial";
  const expectedCommandAction = slicedApplication && sliceAction === "initial"
    ? "start_slice" as const
    : slicedApplication && sliceAction === "advance"
      ? "advance_slice" as const
      : null;

  const explicitWorkflowCommandId = normalizeId(input.explicitWorkflowCommandId) || null;
  const workflowCommandId = explicitWorkflowCommandId
    ?? (expectedCommandAction && input.pendingCommand?.action === expectedCommandAction ? input.pendingCommand.id : null);

  if (input.durableHasProjectPlan && expectedCommandAction && !workflowCommandId) {
    throw new Error(`Core has no pending ${expectedCommandAction} command for this project.`);
  }

  const kind: PlanningTaskKind = input.mode === "ask"
    ? "ask"
    : slicedApplication
      ? "frontend_slice"
      : focus?.type === "page"
        ? "focused_page"
        : focus?.type === "component"
          ? "focused_component"
          : styleFocus
            ? "global_styles"
            : rawSliceAction === "backend"
              ? "backend"
              : projectPlanning
                ? "project_plan"
                : "general";

  const workflowIntent = slicedApplication
    ? "frontend_slice" as const
    : rawSliceAction === "backend"
      ? "backend" as const
      : projectPlanning
        ? "project_plan" as const
        : "general" as const;

  const workflowDetail = slicedApplication
    ? "Continuing the approved project workflow without repository rediscovery."
    : focus
      ? `Planning a focused ${focus.type} edit without changing the main frontend slice workflow.`
      : styleFocus
        ? "Planning a global style edit without changing the main frontend slice workflow."
        : "Planning the requested project work.";

  return {
    kind,
    rawSliceAction,
    sliceAction,
    projectPlanning,
    slicedApplication,
    miniLoop,
    styleFocus,
    focus,
    expectedCommandAction,
    workflowCommandId,
    workflowIntent,
    workflowDetail,
  };
}

export type TaskEventLike = {
  type: string;
  payload?: Record<string, unknown>;
};

export type ExecutionScopeMarkers = {
  focus: FocusedScope | null;
  styleWorkspace: boolean;
  frontendSliceSelected: boolean;
  backendPhase: boolean;
};

export function resolveExecutionScopeMarkers(events: readonly TaskEventLike[], hasWebsite: boolean): ExecutionScopeMarkers {
  const focusedEvent = [...events].reverse().find((event) => event.type === "FOCUSED_WORKSPACE_SELECTED");
  const scopeType = focusedEvent?.payload?.scopeType;
  const scopeId = normalizeId(typeof focusedEvent?.payload?.scopeId === "string" ? focusedEvent.payload.scopeId : "");
  const focus = hasWebsite
    && (scopeType === "page" || scopeType === "component")
    && scopeId
    ? { type: scopeType, id: scopeId } as FocusedScope
    : null;

  return {
    focus,
    styleWorkspace: hasWebsite && events.some((event) => event.type === "STYLE_WORKSPACE_SELECTED"),
    frontendSliceSelected: hasWebsite && events.some((event) => event.type === "FRONTEND_SLICE_SELECTED"),
    backendPhase: hasWebsite && events.some((event) => event.type === "BACKEND_PHASE_SELECTED"),
  };
}

export type ExecutionTaskScope = {
  kind: "frontend_slice" | "focused_page" | "focused_component" | "global_styles" | "backend" | "general";
  focus: FocusedScope | null;
  styleWorkspace: boolean;
  frontendSlice: boolean;
  backendPhase: boolean;
  websiteWorkflow: WebsiteWorkflowKind;
};

export function resolveExecutionTaskScope(input: {
  events: readonly TaskEventLike[];
  hasWebsite: boolean;
  hasProjectPlan: boolean;
  hasSliceState: boolean;
  priorDeliveredWebsiteTask: boolean;
}): ExecutionTaskScope {
  const markers = resolveExecutionScopeMarkers(input.events, input.hasWebsite);
  const focus = markers.focus;
  const styleWorkspace = markers.styleWorkspace;
  const frontendSlice = markers.frontendSliceSelected && input.hasProjectPlan && input.hasSliceState;
  const backendPhase = markers.backendPhase;

  const websiteWorkflow: WebsiteWorkflowKind = styleWorkspace || focus
    ? "iterative_edit"
    : frontendSlice
      ? "initial_generation"
      : input.priorDeliveredWebsiteTask
        ? "iterative_edit"
        : "initial_generation";

  const kind = focus?.type === "page"
    ? "focused_page" as const
    : focus?.type === "component"
      ? "focused_component" as const
      : styleWorkspace
        ? "global_styles" as const
        : frontendSlice
          ? "frontend_slice" as const
          : backendPhase
            ? "backend" as const
            : "general" as const;

  return {
    kind,
    focus,
    styleWorkspace,
    frontendSlice,
    backendPhase,
    websiteWorkflow,
  };
}
