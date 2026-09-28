import type { PermissionMode } from "../../../packages/core/src/chat-session.ts";
import type { WorkflowState } from "../../../packages/core/src/contracts.ts";
import type { ProjectModel } from "../../../packages/web-builder/src/project-model.ts";

export const requestIntents = [
  "question",
  "quick_edit",
  "slice_feedback",
  "focused_component",
  "focused_page",
  "global_styles",
  "structural_change",
  "backend_change",
  "workflow_command",
] as const;
export type RequestIntent = (typeof requestIntents)[number];

export const changeImpacts = ["local", "scoped", "global", "structural"] as const;
export type ChangeImpact = (typeof changeImpacts)[number];

export type RequestIntentDecision = {
  intent: RequestIntent;
  impact: ChangeImpact;
  scope: { type: "page" | "component"; id: string } | null;
  routedSliceAction: string;
  requiresPlanRevision: boolean;
  confidence: "high" | "medium";
  reasons: string[];
};

export type RequestIntentInput = {
  request: string;
  mode: PermissionMode;
  requestedSliceAction: string;
  requestedScopeId?: string | null;
  explicitWorkflowCommandId?: string | null;
  workflow: WorkflowState | null;
  projectModel?: ProjectModel | null;
  currentFocus?: { type: "page" | "component"; id: string } | null;
  runtimeActive?: boolean;
};

const questionPattern = /^(?:how|what|why|when|where|who|which|can you explain|could you explain|tell me|show me|is there|are there|does|do)\b/i;
const structuralPattern = /\b(?:add|create|remove|delete|replace|new)\s+(?:a\s+|an\s+|the\s+)?(?:[a-z0-9-]+\s+){0,3}(?:page|route|screen|flow|service|database|table|endpoint)\b|\b(?:site map|sitemap|navigation structure|information architecture)\b/i;
const backendPattern = /\b(?:api|backend|database|schema|migration|server|endpoint|authentication|authorization|webhook)\b/i;
const globalStylePattern = /\b(?:entire|whole|all|sitewide|site-wide|global)\b.*\b(?:site|app|pages?|color|colour|font|typography|theme|style|spacing|radius|rounded|navy|cream)\b|\b(?:design system|color palette|colour palette|global styles?)\b/i;
const sliceFeedbackPattern = /\b(?:just built|current slice|this slice|before continuing|you just|the hero you|revise (?:it|this))\b/i;
const mutationPattern = /\b(?:make|change|update|adjust|increase|decrease|smaller|larger|fix|improve|remove|add|create|replace|rename|style)\b/i;

function normalized(value: string | null | undefined) { return String(value ?? "").trim(); }
function terms(value: string) { return value.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 2); }

function mentionedEntity(request: string, model: ProjectModel | null | undefined) {
  if (!model) return null;
  const haystack = new Set(terms(request));
  const score = (item: { id: string; name: string }) => terms(`${item.id} ${item.name}`).filter((term) => haystack.has(term)).length;
  const components = model.components.map((item) => ({ item, score: score(item) })).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score);
  const pages = model.pages.map((item) => ({ item, score: score(item) })).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score);
  if ((components[0]?.score ?? 0) >= (pages[0]?.score ?? 0) && components[0]) return { type: "component" as const, id: components[0].item.id };
  if (pages[0]) return { type: "page" as const, id: pages[0].item.id };
  return null;
}

/** Proposes request intent and scope. WorkflowEngine still validates every resulting transition. */
export function routeRequestIntent(input: RequestIntentInput): RequestIntentDecision {
  const request = input.request.trim();
  const action = normalized(input.requestedSliceAction) || "initial";
  const requestedScopeId = normalized(input.requestedScopeId);
  const explicitCommand = normalized(input.explicitWorkflowCommandId);
  const explicitFocus = (action === "page" || action === "component") && requestedScopeId
    ? { type: action as "page" | "component", id: requestedScopeId }
    : null;

  if (input.mode === "ask" || questionPattern.test(request)) {
    return { intent: "question", impact: "local", scope: null, routedSliceAction: "question", requiresPlanRevision: false, confidence: "high", reasons: [input.mode === "ask" ? "ASK mode is non-mutating." : "The request is phrased as a question."] };
  }
  if (explicitCommand) {
    return { intent: "workflow_command", impact: "scoped", scope: null, routedSliceAction: action, requiresPlanRevision: false, confidence: "high", reasons: ["The desktop workflow driver supplied an explicit Core command id."] };
  }
  if (action === "backend") {
    return { intent: "backend_change", impact: "scoped", scope: null, routedSliceAction: "backend", requiresPlanRevision: false, confidence: "high", reasons: ["The Backend workspace was selected explicitly."] };
  }
  if (action === "style") {
    return { intent: "global_styles", impact: "global", scope: null, routedSliceAction: "style", requiresPlanRevision: false, confidence: "high", reasons: ["The Styles workspace was selected explicitly."] };
  }
  if (explicitFocus) {
    return { intent: explicitFocus.type === "page" ? "focused_page" : "focused_component", impact: "scoped", scope: explicitFocus, routedSliceAction: explicitFocus.type, requiresPlanRevision: false, confidence: "high", reasons: [`The ${explicitFocus.type} workspace was selected explicitly.`] };
  }
  if (action === "advance" || action === "revise") {
    return { intent: "slice_feedback", impact: "scoped", scope: null, routedSliceAction: action, requiresPlanRevision: false, confidence: "high", reasons: [`The frontend workflow requested ${action}.`] };
  }
  if (action === "initial" && !input.workflow?.projectPlan && !input.projectModel) {
    return { intent: "structural_change", impact: "structural", scope: null, routedSliceAction: "initial", requiresPlanRevision: false, confidence: "high", reasons: ["This is a new website without a project plan, so the request must enter initial project planning."] };
  }
  if (structuralPattern.test(request)) {
    return { intent: "structural_change", impact: "structural", scope: null, routedSliceAction: "structural", requiresPlanRevision: true, confidence: "high", reasons: ["The request changes the planned project structure."] };
  }
  if (globalStylePattern.test(request)) {
    return { intent: "global_styles", impact: "global", scope: null, routedSliceAction: "style", requiresPlanRevision: false, confidence: "high", reasons: ["The request changes site-wide visual rules."] };
  }
  if (backendPattern.test(request)) {
    return { intent: "backend_change", impact: "scoped", scope: null, routedSliceAction: "backend", requiresPlanRevision: false, confidence: "medium", reasons: ["The request names backend or data concerns."] };
  }
  if (sliceFeedbackPattern.test(request) && input.workflow?.sliceIndex != null) {
    return { intent: "slice_feedback", impact: "scoped", scope: null, routedSliceAction: "revise", requiresPlanRevision: false, confidence: "high", reasons: ["The request refers to the current or most recently built slice."] };
  }

  const scope = input.currentFocus ?? mentionedEntity(request, input.projectModel) ?? null;
  if (scope && mutationPattern.test(request)) {
    return { intent: scope.type === "page" ? "focused_page" : "focused_component", impact: "local", scope, routedSliceAction: scope.type, requiresPlanRevision: false, confidence: "medium", reasons: [`The request matches the known ${scope.type} '${scope.id}'.`] };
  }
  if (mutationPattern.test(request) && input.workflow?.projectPlan) {
    return { intent: "quick_edit", impact: "local", scope: null, routedSliceAction: "quick_edit", requiresPlanRevision: false, confidence: "medium", reasons: ["The request asks for a bounded mutation without an explicit workflow command."] };
  }

  return { intent: input.workflow?.projectPlan ? "quick_edit" : "structural_change", impact: input.workflow?.projectPlan ? "scoped" : "structural", scope: null, routedSliceAction: input.workflow?.projectPlan ? "quick_edit" : "initial", requiresPlanRevision: Boolean(input.workflow?.projectPlan), confidence: "medium", reasons: [input.workflow?.projectPlan ? "The request is scoped conservatively and cannot consume a pending slice command." : "No approved project plan exists, so the request must enter project planning."] };
}
