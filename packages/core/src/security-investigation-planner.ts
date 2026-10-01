import { z } from "zod";
import {
  SecurityInvestigationPlanSchema,
  SecurityInvestigationSubjectSchema,
  type AssessmentScope,
  type ExecutionNode,
  type SecurityAssessment,
  type SecurityInvestigationPlan,
  type SecurityInvestigationStep,
  type SecurityInvestigationSubject,
  type SecurityTarget,
} from "./security-domain.ts";
import { createSecurityToolRequest, decideSecurityToolRequest } from "./security-tool-policy.ts";

export const CreateSecurityInvestigationPlanInputSchema = z.object({
  id: z.string().trim().min(1),
  assessmentId: z.string().trim().min(1),
  objective: z.string().trim().min(1).max(4000),
  subjects: z.array(SecurityInvestigationSubjectSchema).min(1).max(100),
});

type Candidate = {
  toolId: string;
  operationId: string;
  title: string;
  target: SecurityTarget;
  arguments: Record<string, unknown>;
  expectedEvidence: string[];
};

function candidatesFor(subject: SecurityInvestigationSubject): Candidate[] {
  if (subject.kind === "domain") return [
    { toolId: "dig", operationId: "dns_lookup", title: `Resolve ${subject.value}`, target: { kind: "domain", value: subject.value }, arguments: { domain: subject.value }, expectedEvidence: ["dns_records", "stdout", "stderr"] },
    { toolId: "dnsrecon", operationId: "domain_recon", title: `Collect DNS records for ${subject.value}`, target: { kind: "domain", value: subject.value }, arguments: { domain: subject.value }, expectedEvidence: ["dns_records", "domains", "stdout", "stderr"] },
  ];
  if (subject.kind === "host") return [{ toolId: "nmap", operationId: "service_inventory", title: `Inventory services on ${subject.value}`, target: { kind: "host", value: subject.value }, arguments: { host: subject.value, portProfile: "top_100" }, expectedEvidence: ["network_services", "stdout", "stderr"] }];
  if (subject.kind === "email") return [
    { toolId: "theharvester", operationId: "public_email_search", title: `Find public references to ${subject.value}`, target: { kind: "email", value: subject.value }, arguments: { email: subject.value }, expectedEvidence: ["identity_references", "stdout", "stderr"] },
    { toolId: "holehe", operationId: "email_account_search", title: `Check public account clues for ${subject.value}`, target: { kind: "email", value: subject.value }, arguments: { email: subject.value }, expectedEvidence: ["identity_references", "stdout", "stderr"] },
  ];
  if (subject.kind === "username") return [
    { toolId: "sherlock", operationId: "public_username_search", title: `Find public profiles for ${subject.value}`, target: { kind: "username", value: subject.value }, arguments: { username: subject.value }, expectedEvidence: ["profile_references", "stdout", "stderr"] },
    { toolId: "maigret", operationId: "maigret_username_search", title: `Collect profile metadata for ${subject.value}`, target: { kind: "username", value: subject.value }, arguments: { username: subject.value }, expectedEvidence: ["profile_references", "stdout", "stderr"] },
  ];
  if (subject.kind === "phone") return [{ toolId: "phoneinfoga", operationId: "phone_enrichment", title: `Enrich ${subject.value} from public sources`, target: { kind: "phone", value: subject.value }, arguments: { phone: subject.value }, expectedEvidence: ["identity_references", "stdout", "stderr"] }];
  if (subject.kind === "url") return [
    { toolId: "whatweb", operationId: "web_fingerprint", title: `Identify technologies on ${subject.value}`, target: { kind: "url", value: subject.value }, arguments: { url: subject.value }, expectedEvidence: ["web_technologies", "stdout", "stderr"] },
    { toolId: "gobuster", operationId: "web_content_discovery", title: `Discover content on ${subject.value}`, target: { kind: "url", value: subject.value }, arguments: { url: subject.value, profile: "common_bounded" }, expectedEvidence: ["web_paths", "stdout", "stderr"] },
  ];
  return [];
}

function blockedStep(id: string, sequence: number, subject: SecurityInvestigationSubject): SecurityInvestigationStep {
  const preferred = subject.kind === "cidr" ? "nmap" : null;
  const reason = "Network-range discovery has no enabled typed adapter yet; service inventory currently accepts one host.";
  return { id, sequence, title: `Research ${subject.value}`, status: "blocked", toolId: preferred, operationId: null, subject, reason, toolRequest: null };
}

export function createSecurityInvestigationPlan(input: z.input<typeof CreateSecurityInvestigationPlanInputSchema> & {
  assessment: SecurityAssessment;
  scope: AssessmentScope;
  node: ExecutionNode;
  createId: () => string;
}): SecurityInvestigationPlan {
  const value = CreateSecurityInvestigationPlanInputSchema.parse(input);
  if (value.assessmentId !== input.assessment.id) throw new Error("Investigation plan assessment does not match the supplied assessment.");

  const expanded: Array<{ subject: SecurityInvestigationSubject; candidate: Candidate | null }> = value.subjects.flatMap((subject): Array<{ subject: SecurityInvestigationSubject; candidate: Candidate | null }> => {
    const candidates = candidatesFor(subject);
    return candidates.length ? candidates.map((candidate) => ({ subject, candidate })) : [{ subject, candidate: null }];
  });
  const steps = expanded.map(({ subject, candidate }, index): SecurityInvestigationStep => {
    const sequence = index + 1;
    if (!candidate) return blockedStep(input.createId(), sequence, subject);
    const decision = decideSecurityToolRequest({ assessment: input.assessment, scope: input.scope, node: input.node, toolId: candidate.toolId, operationId: candidate.operationId, targets: [candidate.target] });
    if (!decision.allowed || !decision.tool) {
      return { id: input.createId(), sequence, title: candidate.title, status: "blocked", toolId: candidate.toolId, operationId: candidate.operationId, subject, reason: decision.reason, toolRequest: null };
    }
    const operationId = input.createId();
    const request = createSecurityToolRequest({
      id: input.createId(), assessmentId: input.assessment.id, toolId: candidate.toolId, operationId,
      purpose: `${value.objective} Step ${sequence}: ${candidate.title}.`, arguments: candidate.arguments,
      targets: [candidate.target], expectedEvidence: candidate.expectedEvidence,
      risk: decision.tool.defaultRisk, approvalRequirement: decision.approvalRequirement,
    });
    return { id: input.createId(), sequence, title: candidate.title, status: "proposed", toolId: candidate.toolId, operationId, subject, reason: decision.reason, toolRequest: request };
  });
  const proposed = steps.filter((step) => step.status === "proposed").length;
  const now = new Date().toISOString();
  return SecurityInvestigationPlanSchema.parse({
    id: value.id, assessmentId: value.assessmentId, objective: value.objective, subjects: value.subjects, steps,
    status: proposed === 0 ? "blocked" : proposed === steps.length ? "ready" : "draft",
    createdAt: now, updatedAt: now,
  });
}
