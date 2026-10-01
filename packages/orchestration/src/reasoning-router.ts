export type ReasoningRouteInput = {
  mode: "ask" | "plan" | "edit" | "agent";
  intent: string;
  impact: "local" | "scoped" | "global" | "structural";
  confidence: "high" | "medium";
  requiresPlanRevision: boolean;
  deterministicPlanAvailable: boolean;
  sourceFileCount?: number;
};

export type ReasoningRouteDecision = {
  useReasoningModel: boolean;
  reason: string;
};

/**
 * Keeps model selection deterministic and inspectable. This router selects an
 * inference role only; it never grants tools or performs side effects.
 */
export function routeReasoningModel(input: ReasoningRouteInput): ReasoningRouteDecision {
  if (input.mode === "ask" || input.intent === "question") {
    return { useReasoningModel: false, reason: "Conversational requests use the current session model." };
  }
  if (input.deterministicPlanAvailable && input.impact === "local") {
    return { useReasoningModel: false, reason: "A bounded single-file plan was derived deterministically." };
  }
  if (input.requiresPlanRevision) {
    return { useReasoningModel: true, reason: "The request requires revision of approved plan authority." };
  }
  if (input.confidence === "medium") {
    return { useReasoningModel: true, reason: "Intent classification is ambiguous and needs architectural planning." };
  }
  if (input.impact === "global" || input.impact === "structural") {
    return { useReasoningModel: true, reason: `The request has ${input.impact} impact.` };
  }
  if (input.intent === "backend_change") {
    return { useReasoningModel: true, reason: "Backend work requires contract and side-effect planning." };
  }
  if ((input.sourceFileCount ?? 0) > 1) {
    return { useReasoningModel: true, reason: "The scoped change crosses multiple source files." };
  }
  if (input.impact === "scoped") {
    return { useReasoningModel: true, reason: "Scoped implementation work requires an architect handoff." };
  }
  return { useReasoningModel: true, reason: "No safe deterministic plan is available for this implementation request." };
}
