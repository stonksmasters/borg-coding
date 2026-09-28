import {
  AssessmentScopeSchema,
  SecurityAssessmentSchema,
  type AssessmentScope,
  type SecurityAssessment,
} from "./security-domain.ts";
import {
  evaluateScopeTarget,
  type ScopeDecision,
  type SecurityTarget,
} from "./security-scope.ts";

export const securityOperationClasses = ["passive", "active_recon", "manual"] as const;
export type SecurityOperationClass = (typeof securityOperationClasses)[number];

export type SecurityOperationRequest = {
  operation: string;
  classification: SecurityOperationClass;
  targets: SecurityTarget[];
};

export type SecurityOperationDecision = {
  allowed: boolean;
  reason: string;
  targetDecisions: ScopeDecision[];
};

function modeAllowsOperation(mode: SecurityAssessment["mode"], classification: SecurityOperationClass): boolean {
  if (classification === "manual") return false;
  if (classification === "passive") return true;
  return mode === "active_recon" || mode === "authorized_assessment";
}

export function authorizeSecurityOperation(input: {
  assessment: SecurityAssessment;
  scope: AssessmentScope;
  request: SecurityOperationRequest;
}): SecurityOperationDecision {
  const assessment = SecurityAssessmentSchema.parse(input.assessment);
  const scope = AssessmentScopeSchema.parse(input.scope);

  if (assessment.scopeId !== scope.id) {
    return { allowed: false, reason: "Assessment and scope do not match.", targetDecisions: [] };
  }

  if (input.request.classification === "manual") {
    return {
      allowed: false,
      reason: "Manual security operations are not authorized through the autonomous execution path.",
      targetDecisions: [],
    };
  }

  if (!modeAllowsOperation(assessment.mode, input.request.classification)) {
    return {
      allowed: false,
      reason: `Assessment mode ${assessment.mode} does not permit ${input.request.classification} operations.`,
      targetDecisions: [],
    };
  }

  if (input.request.classification === "active_recon" && !scope.authorizationConfirmed) {
    return {
      allowed: false,
      reason: "Active reconnaissance requires explicitly confirmed authorization for the assessment scope.",
      targetDecisions: [],
    };
  }

  if (input.request.targets.length === 0) {
    return { allowed: false, reason: "Security operations require at least one explicit target.", targetDecisions: [] };
  }

  const targetDecisions = input.request.targets.map((target) => evaluateScopeTarget(scope, target));
  const rejected = targetDecisions.find((decision) => !decision.allowed);
  if (rejected) {
    return {
      allowed: false,
      reason: `At least one target is outside the authorized assessment scope: ${rejected.normalizedTarget}.`,
      targetDecisions,
    };
  }

  return {
    allowed: true,
    reason: "Operation classification and all targets are permitted by the assessment scope.",
    targetDecisions,
  };
}

export function assertSecurityOperationAuthorized(input: {
  assessment: SecurityAssessment;
  scope: AssessmentScope;
  request: SecurityOperationRequest;
}): SecurityOperationDecision {
  const decision = authorizeSecurityOperation(input);
  if (!decision.allowed) throw new Error(`Security operation rejected: ${decision.reason}`);
  return decision;
}
