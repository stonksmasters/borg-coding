import { z } from "zod";

export const securityAssessmentModes = [
  "osint",
  "passive_recon",
  "active_recon",
  "authorized_assessment",
] as const;

export const securityAssessmentStatuses = [
  "draft",
  "planning",
  "running",
  "paused",
  "completed",
  "failed",
] as const;

export const executionNodeProviders = ["local", "ssh"] as const;
export const executionNodeStatuses = ["unknown", "online", "offline", "error"] as const;
export const capabilityStatuses = ["available", "missing", "error"] as const;
export const capabilityCategories = ["dns", "network", "web", "osint", "utility"] as const;

const nonEmptyValue = z.string().trim().min(1);

export const AssessmentScopeSchema = z.object({
  id: z.string().min(1),
  allowedDomains: z.array(nonEmptyValue).default([]),
  allowedHosts: z.array(nonEmptyValue).default([]),
  allowedCidrs: z.array(nonEmptyValue).default([]),
  excludedDomains: z.array(nonEmptyValue).default([]),
  excludedHosts: z.array(nonEmptyValue).default([]),
  excludedCidrs: z.array(nonEmptyValue).default([]),
  authorizationConfirmed: z.boolean().default(false),
  authorizationConfirmedAt: z.string().datetime().nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).superRefine((scope, context) => {
  if (scope.authorizationConfirmed && !scope.authorizationConfirmedAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["authorizationConfirmedAt"],
      message: "Confirmed assessment scope requires an authorization timestamp.",
    });
  }
  if (!scope.authorizationConfirmed && scope.authorizationConfirmedAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["authorizationConfirmedAt"],
      message: "Authorization timestamp must be null until scope authorization is confirmed.",
    });
  }
});
export type AssessmentScope = z.infer<typeof AssessmentScopeSchema>;

export const ExecutionCapabilitySchema = z.object({
  id: z.string().min(1),
  executable: z.string().min(1),
  category: z.enum(capabilityCategories),
  status: z.enum(capabilityStatuses),
  version: z.string().min(1).nullable().default(null),
  detail: z.string().nullable().default(null),
  checkedAt: z.string().datetime(),
});
export type ExecutionCapability = z.infer<typeof ExecutionCapabilitySchema>;

export const ExecutionNodeSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  provider: z.enum(executionNodeProviders),
  host: z.string().trim().min(1).nullable().default(null),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().trim().min(1).nullable().default(null),
  credentialRef: z.string().trim().min(1).nullable().default(null),
  workingDirectory: z.string().trim().min(1).nullable().default(null),
  platform: z.string().trim().min(1).nullable().default(null),
  architecture: z.string().trim().min(1).nullable().default(null),
  status: z.enum(executionNodeStatuses).default("unknown"),
  capabilities: z.array(ExecutionCapabilitySchema).default([]),
  lastSeenAt: z.string().datetime().nullable().default(null),
  lastError: z.string().nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).superRefine((node, context) => {
  if (node.provider !== "ssh") return;
  if (!node.host) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["host"], message: "SSH execution nodes require a host." });
  }
  if (!node.username) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["username"], message: "SSH execution nodes require a username." });
  }
});
export type ExecutionNode = z.infer<typeof ExecutionNodeSchema>;

export const SecurityAssessmentSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  mode: z.enum(securityAssessmentModes),
  status: z.enum(securityAssessmentStatuses).default("draft"),
  scopeId: z.string().min(1),
  executionNodeId: z.string().min(1).nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type SecurityAssessment = z.infer<typeof SecurityAssessmentSchema>;

function unique(values: readonly string[], lowercase = false): string[] {
  const normalized = values
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => lowercase ? value.toLowerCase() : value);
  return [...new Set(normalized)];
}

export function createAssessmentScope(input: {
  id: string;
  allowedDomains?: string[];
  allowedHosts?: string[];
  allowedCidrs?: string[];
  excludedDomains?: string[];
  excludedHosts?: string[];
  excludedCidrs?: string[];
  authorizationConfirmed?: boolean;
}): AssessmentScope {
  const now = new Date().toISOString();
  const confirmed = input.authorizationConfirmed ?? false;
  return AssessmentScopeSchema.parse({
    id: input.id,
    allowedDomains: unique(input.allowedDomains ?? [], true),
    allowedHosts: unique(input.allowedHosts ?? [], true),
    allowedCidrs: unique(input.allowedCidrs ?? []),
    excludedDomains: unique(input.excludedDomains ?? [], true),
    excludedHosts: unique(input.excludedHosts ?? [], true),
    excludedCidrs: unique(input.excludedCidrs ?? []),
    authorizationConfirmed: confirmed,
    authorizationConfirmedAt: confirmed ? now : null,
    createdAt: now,
    updatedAt: now,
  });
}

export function createSecurityAssessment(input: {
  id: string;
  projectId: string;
  name: string;
  mode: SecurityAssessment["mode"];
  scopeId: string;
  executionNodeId?: string | null;
}): SecurityAssessment {
  const now = new Date().toISOString();
  return SecurityAssessmentSchema.parse({
    ...input,
    executionNodeId: input.executionNodeId ?? null,
    status: "draft",
    createdAt: now,
    updatedAt: now,
  });
}

export function createExecutionNode(input: {
  id: string;
  name: string;
  provider: ExecutionNode["provider"];
  host?: string | null;
  port?: number;
  username?: string | null;
  credentialRef?: string | null;
  workingDirectory?: string | null;
}): ExecutionNode {
  const now = new Date().toISOString();
  return ExecutionNodeSchema.parse({
    ...input,
    host: input.host ?? null,
    port: input.port ?? 22,
    username: input.username ?? null,
    credentialRef: input.credentialRef ?? null,
    workingDirectory: input.workingDirectory ?? null,
    platform: null,
    architecture: null,
    status: "unknown",
    capabilities: [],
    lastSeenAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  });
}
