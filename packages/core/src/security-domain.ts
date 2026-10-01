import { createHash } from "node:crypto";
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

export const securityOperationClasses = ["passive", "active_recon", "manual"] as const;
export const securityExecutionStatuses = ["planned", "approved", "running", "succeeded", "failed", "cancelled", "blocked"] as const;
export const securityEvidenceKinds = ["stdout", "stderr", "normalized", "artifact", "note"] as const;
export const securityAssetKinds = ["domain", "ip_address", "network", "host", "file", "software", "email", "username", "phone", "profile", "url"] as const;
export const securityRelationshipKinds = ["resolves_to", "aliases_to", "contains_host", "has_subdomain", "contains_path", "has_profile", "uses_domain", "possible_same_identity"] as const;
export const securityRelationshipConfidence = ["confirmed", "strong", "possible", "unverified", "conflicting"] as const;
export const securityToolApprovalRequirements = ["none", "execution", "intrusive"] as const;
export const identityIdentifierKinds = ["email", "username", "phone", "domain", "url"] as const;
export const identityIdentifierStatuses = ["confirmed", "candidate", "rejected"] as const;
export const securityJobStatuses = ["queued", "awaiting_approval", "running", "succeeded", "failed", "cancelled"] as const;

export const SecurityTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("email"), value: z.string().trim().email() }),
  z.object({ kind: z.literal("username"), value: z.string().trim().min(1) }),
  z.object({ kind: z.literal("phone"), value: z.string().trim().min(3) }),
  z.object({ kind: z.literal("domain"), value: z.string().trim().min(1) }),
  z.object({ kind: z.literal("url"), value: z.string().trim().url() }),
  z.object({ kind: z.literal("host"), value: z.string().trim().min(1) }),
  z.object({ kind: z.literal("cidr"), value: z.string().trim().min(1) }),
  z.object({ kind: z.literal("file"), value: z.string().trim().min(1) }),
  z.object({ kind: z.literal("query"), value: z.string().trim().min(1) }),
]);
export type SecurityTarget = z.infer<typeof SecurityTargetSchema>;

export const SecurityToolRequestSchema = z.object({
  id: z.string().min(1),
  assessmentId: z.string().min(1),
  toolId: z.string().trim().min(1),
  operationId: z.string().trim().min(1),
  purpose: z.string().trim().min(1).max(1000),
  arguments: z.record(z.string(), z.unknown()).default({}),
  targets: z.array(SecurityTargetSchema).min(1),
  expectedEvidence: z.array(z.string().trim().min(1)).min(1),
  risk: z.enum(["passive", "external_passive", "active", "intrusive"]),
  approvalRequirement: z.enum(securityToolApprovalRequirements),
  createdAt: z.string().datetime(),
});
export type SecurityToolRequest = z.infer<typeof SecurityToolRequestSchema>;

export const SecurityInvestigationSubjectSchema = z.object({
  kind: z.enum(["email", "username", "phone", "domain", "url", "host", "cidr", "file", "query"]),
  value: z.string().trim().min(1).max(500),
});
export type SecurityInvestigationSubject = z.infer<typeof SecurityInvestigationSubjectSchema>;

export const SecurityInvestigationStepSchema = z.object({
  id: z.string().min(1),
  sequence: z.number().int().positive(),
  title: z.string().trim().min(1),
  status: z.enum(["proposed", "blocked"]),
  toolId: z.string().trim().min(1).nullable(),
  operationId: z.string().trim().min(1).nullable(),
  subject: SecurityInvestigationSubjectSchema,
  reason: z.string().trim().min(1),
  toolRequest: SecurityToolRequestSchema.nullable(),
});
export type SecurityInvestigationStep = z.infer<typeof SecurityInvestigationStepSchema>;

export const SecurityInvestigationPlanSchema = z.object({
  id: z.string().min(1),
  assessmentId: z.string().min(1),
  objective: z.string().trim().min(1).max(4000),
  status: z.enum(["draft", "ready", "blocked"]),
  subjects: z.array(SecurityInvestigationSubjectSchema).min(1),
  steps: z.array(SecurityInvestigationStepSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type SecurityInvestigationPlan = z.infer<typeof SecurityInvestigationPlanSchema>;

const nonEmptyValue = z.string().trim().min(1);

export const AssessmentScopeSchema = z.object({
  id: z.string().min(1),
  allowedDomains: z.array(nonEmptyValue).default([]),
  allowedEmails: z.array(nonEmptyValue).default([]),
  allowedUsernames: z.array(nonEmptyValue).default([]),
  allowedPhones: z.array(nonEmptyValue).default([]),
  allowedUrls: z.array(nonEmptyValue).default([]),
  allowedHosts: z.array(nonEmptyValue).default([]),
  allowedCidrs: z.array(nonEmptyValue).default([]),
  allowedFiles: z.array(nonEmptyValue).default([]),
  allowedQueries: z.array(nonEmptyValue).default([]),
  excludedDomains: z.array(nonEmptyValue).default([]),
  excludedEmails: z.array(nonEmptyValue).default([]),
  excludedUsernames: z.array(nonEmptyValue).default([]),
  excludedPhones: z.array(nonEmptyValue).default([]),
  excludedUrls: z.array(nonEmptyValue).default([]),
  excludedHosts: z.array(nonEmptyValue).default([]),
  excludedCidrs: z.array(nonEmptyValue).default([]),
  excludedFiles: z.array(nonEmptyValue).default([]),
  excludedQueries: z.array(nonEmptyValue).default([]),
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
  securityRuntime: z.enum(["ssh_cli", "kali_mcp"]).default("ssh_cli"),
  mcpServerName: z.string().trim().min(1).nullable().default(null),
  mcpServerVersion: z.string().trim().min(1).nullable().default(null),
  mcpTools: z.array(z.string().trim().min(1)).default([]),
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

export const SecurityExecutionRecordSchema = z.object({
  id: z.string().min(1),
  assessmentId: z.string().min(1),
  taskId: z.string().min(1),
  workflowVersion: z.number().int().positive(),
  nodeId: z.string().min(1),
  operationId: z.string().min(1),
  operation: z.string().trim().min(1).max(200),
  classification: z.enum(securityOperationClasses),
  targets: z.array(SecurityTargetSchema).min(1),
  provider: z.enum(executionNodeProviders),
  transport: z.enum(["ssh_cli", "kali_mcp"]).default("ssh_cli"),
  mcpTool: z.string().trim().min(1).nullable().default(null),
  underlyingExecutable: z.string().trim().min(1).nullable().default(null),
  toolRequest: SecurityToolRequestSchema.nullable().default(null),
  status: z.enum(securityExecutionStatuses),
  startedAt: z.string().datetime().nullable().default(null),
  completedAt: z.string().datetime().nullable().default(null),
  exitCode: z.number().int().nullable().default(null),
  timedOut: z.boolean().default(false),
  cancelled: z.boolean().default(false),
  error: z.string().nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type SecurityExecutionRecord = z.infer<typeof SecurityExecutionRecordSchema>;

export const SecurityEvidenceRecordSchema = z.object({
  id: z.string().min(1),
  assessmentId: z.string().min(1),
  executionId: z.string().min(1),
  taskId: z.string().min(1),
  kind: z.enum(securityEvidenceKinds),
  contentType: z.string().trim().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteLength: z.number().int().nonnegative(),
  truncated: z.boolean().default(false),
  storageUri: z.string().trim().min(1).nullable().default(null),
  inlineText: z.string().nullable().default(null),
  createdAt: z.string().datetime(),
});
export type SecurityEvidenceRecord = z.infer<typeof SecurityEvidenceRecordSchema>;

export const SecurityAssetSchema = z.object({
  id: z.string().min(1),
  assessmentId: z.string().min(1),
  kind: z.enum(securityAssetKinds),
  key: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  firstSeenAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  lastExecutionId: z.string().min(1),
  lastEvidenceId: z.string().min(1),
});
export type SecurityAsset = z.infer<typeof SecurityAssetSchema>;

export const SecurityNetworkServiceSchema = z.object({
  id: z.string().min(1),
  assessmentId: z.string().min(1),
  assetId: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  protocol: z.string().trim().min(1),
  state: z.string().trim().min(1),
  name: z.string().trim().min(1),
  product: z.string().trim().min(1).nullable(),
  version: z.string().trim().min(1).nullable(),
  firstSeenAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  lastExecutionId: z.string().min(1),
  lastEvidenceId: z.string().min(1),
});
export type SecurityNetworkService = z.infer<typeof SecurityNetworkServiceSchema>;

export const SecurityObservationSchema = z.object({
  id: z.string().min(1),
  assessmentId: z.string().min(1),
  assetId: z.string().min(1),
  serviceId: z.string().min(1).nullable(),
  executionId: z.string().min(1),
  evidenceId: z.string().min(1),
  type: z.string().trim().min(1),
  data: z.record(z.string(), z.unknown()),
  observedAt: z.string().datetime(),
});
export type SecurityObservation = z.infer<typeof SecurityObservationSchema>;

export const SecurityRelationshipSchema = z.object({
  id: z.string().min(1),
  assessmentId: z.string().min(1),
  sourceAssetId: z.string().min(1),
  targetAssetId: z.string().min(1),
  kind: z.enum(securityRelationshipKinds),
  confidence: z.enum(securityRelationshipConfidence).default("unverified"),
  rationale: z.string().trim().min(1).default("Observed by a security operation."),
  evidenceIds: z.array(z.string().min(1)).default([]),
  firstSeenAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  lastExecutionId: z.string().min(1),
  lastEvidenceId: z.string().min(1),
});
export type SecurityRelationship = z.infer<typeof SecurityRelationshipSchema>;

export const IdentityIdentifierSchema = z.object({
  id: z.string().min(1),
  profileId: z.string().min(1),
  kind: z.enum(identityIdentifierKinds),
  value: z.string().trim().min(1).max(1000),
  normalizedValue: z.string().trim().min(1).max(1000),
  status: z.enum(identityIdentifierStatuses),
  confidence: z.enum(securityRelationshipConfidence).default("unverified"),
  source: z.enum(["user", "tool"]),
  evidenceIds: z.array(z.string().min(1)).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type IdentityIdentifier = z.infer<typeof IdentityIdentifierSchema>;

export const IdentityProfileSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  assessmentId: z.string().min(1),
  displayName: z.string().trim().min(1).max(200),
  notes: z.string().max(10000).default(""),
  executionNodeId: z.string().min(1),
  authorizationConfirmed: z.boolean().default(false),
  authorizationConfirmedAt: z.string().datetime().nullable().default(null),
  archivedAt: z.string().datetime().nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type IdentityProfile = z.infer<typeof IdentityProfileSchema>;

export const SecurityJobSchema = z.object({
  id: z.string().min(1),
  profileId: z.string().min(1),
  assessmentId: z.string().min(1),
  executionId: z.string().min(1),
  nodeId: z.string().min(1),
  operation: z.string().min(1),
  target: SecurityTargetSchema,
  status: z.enum(securityJobStatuses),
  approvalRequired: z.boolean(),
  error: z.string().nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable().default(null),
  completedAt: z.string().datetime().nullable().default(null),
});
export type SecurityJob = z.infer<typeof SecurityJobSchema>;

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
  allowedEmails?: string[];
  allowedUsernames?: string[];
  allowedPhones?: string[];
  allowedUrls?: string[];
  allowedHosts?: string[];
  allowedCidrs?: string[];
  allowedFiles?: string[];
  allowedQueries?: string[];
  excludedDomains?: string[];
  excludedEmails?: string[];
  excludedUsernames?: string[];
  excludedPhones?: string[];
  excludedUrls?: string[];
  excludedHosts?: string[];
  excludedCidrs?: string[];
  excludedFiles?: string[];
  excludedQueries?: string[];
  authorizationConfirmed?: boolean;
}): AssessmentScope {
  const now = new Date().toISOString();
  const confirmed = input.authorizationConfirmed ?? false;
  return AssessmentScopeSchema.parse({
    id: input.id,
    allowedDomains: unique(input.allowedDomains ?? [], true),
    allowedEmails: unique(input.allowedEmails ?? [], true),
    allowedUsernames: unique(input.allowedUsernames ?? [], true),
    allowedPhones: unique(input.allowedPhones ?? []),
    allowedUrls: unique(input.allowedUrls ?? []),
    allowedHosts: unique(input.allowedHosts ?? [], true),
    allowedCidrs: unique(input.allowedCidrs ?? []),
    allowedFiles: unique(input.allowedFiles ?? []),
    allowedQueries: unique(input.allowedQueries ?? [], true),
    excludedDomains: unique(input.excludedDomains ?? [], true),
    excludedEmails: unique(input.excludedEmails ?? [], true),
    excludedUsernames: unique(input.excludedUsernames ?? [], true),
    excludedPhones: unique(input.excludedPhones ?? []),
    excludedUrls: unique(input.excludedUrls ?? []),
    excludedHosts: unique(input.excludedHosts ?? [], true),
    excludedCidrs: unique(input.excludedCidrs ?? []),
    excludedFiles: unique(input.excludedFiles ?? []),
    excludedQueries: unique(input.excludedQueries ?? [], true),
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

export function createSecurityExecutionRecord(input: {
  id: string;
  assessmentId: string;
  taskId: string;
  workflowVersion: number;
  nodeId: string;
  operationId: string;
  operation: string;
  classification: SecurityExecutionRecord["classification"];
  targets: SecurityTarget[];
  provider: SecurityExecutionRecord["provider"];
  transport?: SecurityExecutionRecord["transport"];
  mcpTool?: string | null;
  underlyingExecutable?: string | null;
  toolRequest?: SecurityToolRequest | null;
}): SecurityExecutionRecord {
  const now = new Date().toISOString();
  return SecurityExecutionRecordSchema.parse({
    ...input,
    transport: input.transport ?? "ssh_cli",
    mcpTool: input.mcpTool ?? null,
    underlyingExecutable: input.underlyingExecutable ?? null,
    toolRequest: input.toolRequest ?? null,
    status: "planned",
    startedAt: null,
    completedAt: null,
    exitCode: null,
    timedOut: false,
    cancelled: false,
    error: null,
    createdAt: now,
    updatedAt: now,
  });
}

export function createSecurityEvidenceRecord(input: {
  id: string;
  assessmentId: string;
  executionId: string;
  taskId: string;
  kind: SecurityEvidenceRecord["kind"];
  contentType?: string;
  text: string;
  truncated?: boolean;
  storageUri?: string | null;
}): SecurityEvidenceRecord {
  const bytes = Buffer.from(input.text, "utf8");
  return SecurityEvidenceRecordSchema.parse({
    id: input.id,
    assessmentId: input.assessmentId,
    executionId: input.executionId,
    taskId: input.taskId,
    kind: input.kind,
    contentType: input.contentType ?? "text/plain; charset=utf-8",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
    truncated: input.truncated ?? false,
    storageUri: input.storageUri ?? null,
    inlineText: input.text,
    createdAt: new Date().toISOString(),
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
  securityRuntime?: ExecutionNode["securityRuntime"];
}): ExecutionNode {
  const now = new Date().toISOString();
  return ExecutionNodeSchema.parse({
    ...input,
    host: input.host ?? null,
    port: input.port ?? 22,
    username: input.username ?? null,
    credentialRef: input.credentialRef ?? null,
    workingDirectory: input.workingDirectory ?? null,
    securityRuntime: input.securityRuntime ?? "ssh_cli",
    mcpServerName: null,
    mcpServerVersion: null,
    mcpTools: [],
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
