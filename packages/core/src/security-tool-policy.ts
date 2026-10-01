import { z } from "zod";
import {
  SecurityToolRequestSchema,
  type AssessmentScope,
  type ExecutionNode,
  type SecurityAssessment,
  type SecurityTarget,
  type SecurityToolRequest,
} from "./security-domain.ts";
import { authorizeSecurityOperation, type SecurityOperationDecision } from "./security-policy.ts";
import { defaultSecurityToolRegistry, type SecurityToolDefinition } from "./security-tool-registry.ts";

export const ProposeSecurityToolRequestSchema = z.object({
  id: z.string().trim().min(1),
  assessmentId: z.string().trim().min(1),
  toolId: z.string().trim().min(1),
  operationId: z.string().trim().min(1),
  purpose: z.string().trim().min(1).max(1000),
  arguments: z.record(z.string(), z.unknown()).default({}),
  targets: z.array(z.object({
    kind: z.enum(["email", "username", "phone", "domain", "url", "host", "cidr", "file", "query"]),
    value: z.string().trim().min(1),
  })).min(1),
  expectedEvidence: z.array(z.string().trim().min(1)).min(1),
});

export type SecurityToolRequestDecision = {
  allowed: boolean;
  outcome: "ready" | "approval_required" | "blocked";
  reason: string;
  approvalRequirement: SecurityToolRequest["approvalRequirement"];
  tool: SecurityToolDefinition | null;
  operationPolicy: SecurityOperationDecision | null;
};

function approvalRequirement(tool: SecurityToolDefinition): SecurityToolRequest["approvalRequirement"] {
  if (tool.defaultRisk === "passive" || tool.defaultRisk === "external_passive") return "none";
  if (tool.defaultRisk === "intrusive") return "intrusive";
  return "execution";
}

function operationClass(tool: SecurityToolDefinition): "passive" | "active_recon" {
  return tool.defaultRisk === "passive" || tool.defaultRisk === "external_passive" ? "passive" : "active_recon";
}

export function decideSecurityToolRequest(input: {
  assessment: SecurityAssessment;
  scope: AssessmentScope;
  node: ExecutionNode;
  toolId: string;
  operationId: string;
  targets: SecurityTarget[];
}): SecurityToolRequestDecision {
  const tool = defaultSecurityToolRegistry.find((value) => value.id === input.toolId) ?? null;
  if (!tool) return { allowed: false, outcome: "blocked", reason: `Tool ${input.toolId} is not in the security tool registry.`, approvalRequirement: "execution", tool: null, operationPolicy: null };
  const requirement = approvalRequirement(tool);
  if (tool.executionMode !== "typed_adapter" || !tool.operationIds.includes(input.operationId)) {
    return { allowed: false, outcome: "blocked", reason: `Tool ${tool.id} has no enabled typed adapter for ${input.operationId}.`, approvalRequirement: requirement, tool, operationPolicy: null };
  }
  const capability = input.node.capabilities.find((value) => value.id === tool.id);
  if (capability?.status === "missing" || capability?.status === "error") {
    return { allowed: false, outcome: "blocked", reason: `Tool ${tool.id} is ${capability.status} on execution node ${input.node.id}.`, approvalRequirement: requirement, tool, operationPolicy: null };
  }
  const operationPolicy = authorizeSecurityOperation({
    assessment: input.assessment,
    scope: input.scope,
    request: { operation: input.operationId, classification: operationClass(tool), targets: input.targets },
  });
  if (!operationPolicy.allowed) {
    return { allowed: false, outcome: "blocked", reason: operationPolicy.reason, approvalRequirement: requirement, tool, operationPolicy };
  }
  return {
    allowed: true,
    outcome: requirement === "none" ? "ready" : "approval_required",
    reason: capability
      ? `Tool ${tool.id} is available and the request satisfies scope and risk policy.`
      : `The request satisfies scope and risk policy; refresh node ${input.node.id} before execution to confirm tool availability.`,
    approvalRequirement: requirement,
    tool,
    operationPolicy,
  };
}

export function createSecurityToolRequest(input: z.input<typeof ProposeSecurityToolRequestSchema> & {
  risk: SecurityToolRequest["risk"];
  approvalRequirement: SecurityToolRequest["approvalRequirement"];
}): SecurityToolRequest {
  return SecurityToolRequestSchema.parse({ ...input, createdAt: new Date().toISOString() });
}
