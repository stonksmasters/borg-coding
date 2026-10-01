import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  createAssessmentScope,
  createExecutionNode,
  createSecurityAssessment,
  createSecurityEvidenceRecord,
  createSecurityExecutionRecord,
  SecurityTargetSchema,
  IdentityProfileSchema,
  IdentityIdentifierSchema,
  securityAssessmentModes,
  securityExecutionStatuses,
  securityOperationClasses,
  type ExecutionNode,
  type SecurityAssessment,
  type SecurityExecutionRecord,
  type SecurityAsset,
  type SecurityNetworkService,
  type SecurityObservation,
  type SecurityRelationship,
  type IdentityIdentifier,
} from "../../../packages/core/src/security-domain.ts";
import { KaliMcpProvider, type KaliMcpCallResult, type KaliMcpClientProvider } from "../../../packages/core/src/kali-mcp-provider.ts";
import {
  SshExecutionProvider,
  createExecutionRequest,
  type ExecutionOptions,
  type ExecutionProvider,
} from "../../../packages/core/src/execution-provider.ts";
import { getSecurityOperationAdapter } from "../../../packages/core/src/security-operation-adapters.ts";
import { refreshExecutionNode } from "../../../packages/core/src/security-node-service.ts";
import { securityToolStatuses } from "../../../packages/core/src/security-tool-registry.ts";
import { createSecurityToolRequest, decideSecurityToolRequest } from "../../../packages/core/src/security-tool-policy.ts";
import { createSecurityInvestigationPlan, CreateSecurityInvestigationPlanInputSchema } from "../../../packages/core/src/security-investigation-planner.ts";
import { assertSecurityOperationAuthorized } from "../../../packages/core/src/security-policy.ts";
import { SqliteSecurityRepository } from "../../../packages/persistence/src/sqlite-security-repository.ts";
import { createSecurityInstallPlan, installCommand, SecurityInstallPlanSchema } from "../../../packages/core/src/security-tool-install.ts";

const RegisterExecutionNodeInputSchema = z.object({
  id: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).max(200),
  provider: z.enum(["ssh", "local"]).default("ssh"),
  host: z.string().trim().min(1).nullable().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().trim().min(1).nullable().optional(),
  workingDirectory: z.string().trim().min(1).nullable().optional(),
  credentialRef: z.string().trim().min(1).nullable().optional(),
  securityRuntime: z.enum(["ssh_cli", "kali_mcp"]).default("ssh_cli"),
});

const IdentifierInputSchema = z.object({
  kind: z.enum(["email", "username", "phone", "domain", "url"]),
  value: z.string().trim().min(1).max(1000),
});

const CreateIdentityProfileInputSchema = z.object({
  id: z.string().trim().min(1).optional(),
  projectId: z.string().trim().min(1),
  displayName: z.string().trim().min(1).max(200),
  notes: z.string().max(10000).default(""),
  executionNodeId: z.string().trim().min(1),
  authorizationConfirmed: z.boolean().default(false),
  identifiers: z.array(IdentifierInputSchema).default([]),
});

const UpdateIdentityProfileInputSchema = z.object({
  displayName: z.string().trim().min(1).max(200).optional(),
  notes: z.string().max(10000).optional(),
  executionNodeId: z.string().trim().min(1).optional(),
  authorizationConfirmed: z.boolean().optional(),
});

const profileOperations: Record<IdentityIdentifier["kind"], string[]> = {
  username: ["public_username_search", "maigret_username_search", "maigret_full_username_search"],
  email: ["email_account_search", "public_email_search"],
  phone: ["phone_enrichment"],
  domain: ["dns_lookup", "domain_recon", "whois_lookup", "amass_passive_discovery", "dmitry_domain_intel", "dnsenum_discovery", "dnsmap_discovery", "fierce_discovery"],
  url: ["web_fingerprint", "waf_detection", "tls_configuration", "sslscan_configuration", "web_content_discovery", "ffuf_content_discovery", "dirb_content_discovery", "nikto_web_audit", "wpscan_audit", "wfuzz_content_discovery"],
};

function normalizedIdentifier(kind: IdentityIdentifier["kind"], value: string): string {
  const trimmed = value.trim();
  if (kind === "email" || kind === "username" || kind === "domain") return trimmed.toLowerCase().replace(kind === "domain" ? /\.$/ : /$^/, "");
  if (kind === "phone") return trimmed.replace(/[^+\d]/g, "");
  try { return kind === "url" ? new URL(trimmed).toString() : trimmed; } catch { return trimmed; }
}

const AssessmentScopeInputSchema = z.object({
  allowedDomains: z.array(z.string()).default([]),
  allowedEmails: z.array(z.string()).default([]),
  allowedUsernames: z.array(z.string()).default([]),
  allowedPhones: z.array(z.string()).default([]),
  allowedUrls: z.array(z.string()).default([]),
  allowedHosts: z.array(z.string()).default([]),
  allowedCidrs: z.array(z.string()).default([]),
  allowedFiles: z.array(z.string()).default([]),
  allowedQueries: z.array(z.string()).default([]),
  excludedDomains: z.array(z.string()).default([]),
  excludedEmails: z.array(z.string()).default([]),
  excludedUsernames: z.array(z.string()).default([]),
  excludedPhones: z.array(z.string()).default([]),
  excludedUrls: z.array(z.string()).default([]),
  excludedHosts: z.array(z.string()).default([]),
  excludedCidrs: z.array(z.string()).default([]),
  excludedFiles: z.array(z.string()).default([]),
  excludedQueries: z.array(z.string()).default([]),
  authorizationConfirmed: z.boolean().default(false),
});

const CreateSecurityAssessmentInputSchema = z.object({
  id: z.string().trim().min(1).optional(),
  projectId: z.string().trim().min(1),
  name: z.string().trim().min(1).max(200),
  mode: z.enum(securityAssessmentModes),
  executionNodeId: z.string().trim().min(1).nullable().optional(),
  scope: AssessmentScopeInputSchema,
});

const PlanSecurityExecutionInputSchema = z.object({
  id: z.string().trim().min(1).optional(),
  operationId: z.string().trim().min(1).optional(),
  assessmentId: z.string().trim().min(1),
  taskId: z.string().trim().min(1),
  workflowVersion: z.number().int().positive(),
  operation: z.string().trim().min(1).max(200),
  classification: z.enum(securityOperationClasses),
  targets: z.array(SecurityTargetSchema).min(1),
  toolId: z.string().trim().min(1).optional(),
  purpose: z.string().trim().min(1).max(1000).optional(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  expectedEvidence: z.array(z.string().trim().min(1)).min(1).optional(),
});

const RecordSecurityEvidenceInputSchema = z.object({
  id: z.string().trim().min(1).optional(),
  executionId: z.string().trim().min(1),
  kind: z.enum(["stdout", "stderr", "normalized", "artifact", "note"]),
  contentType: z.string().trim().min(1).optional(),
  text: z.string(),
  truncated: z.boolean().optional(),
  storageUri: z.string().trim().min(1).nullable().optional(),
});

function stableSecurityId(prefix: string, ...parts: Array<string | number>): string {
  const digest = createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24);
  return `${prefix}:${digest}`;
}

function cleanDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function mcpResultOutput(result: KaliMcpCallResult): { stdout: string; stderr: string; exitCode: number } {
  const candidates: unknown[] = [result.structuredContent];
  if (result.text.trim().startsWith("{")) {
    try { candidates.push(JSON.parse(result.text)); } catch { /* preserve text below */ }
  }
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const envelope = candidate as Record<string, unknown>;
    const value = envelope.result && typeof envelope.result === "object"
      ? envelope.result as Record<string, unknown>
      : envelope;
    const stdout = typeof value.output === "string"
      ? value.output
      : typeof value.stdout === "string"
        ? value.stdout
        : result.text;
    const stderr = typeof value.stderr === "string"
      ? value.stderr
      : typeof value.error === "string"
        ? value.error
        : "";
    const exitCode = typeof value.exit_code === "number"
      ? value.exit_code
      : typeof value.return_code === "number"
        ? value.return_code
      : typeof value.exitCode === "number"
        ? value.exitCode
        : result.isError || value.success === false ? 1 : 0;
    return { stdout, stderr, exitCode };
  }
  return { stdout: result.text, stderr: result.isError ? result.text : "", exitCode: result.isError ? 1 : 0 };
}

export class SecurityService {
  private readonly repository: SqliteSecurityRepository;
  private readonly sshProvider: ExecutionProvider;
  private readonly kaliMcpProvider: KaliMcpClientProvider;
  private readonly activeExecutions = new Map<string, AbortController>();
  private queueRunning = false;

  constructor(
    databasePath: string,
    sshProvider: ExecutionProvider = new SshExecutionProvider(),
    kaliMcpProvider: KaliMcpClientProvider = new KaliMcpProvider(),
  ) {
    this.repository = new SqliteSecurityRepository(databasePath);
    this.sshProvider = sshProvider;
    this.kaliMcpProvider = kaliMcpProvider;
    for (const job of this.repository.listSecurityJobs()) {
      if (job.status === "running") this.repository.saveSecurityJob({ ...job, status: "queued", startedAt: null, updatedAt: new Date().toISOString() });
    }
    if (this.repository.listSecurityJobs().some((job) => job.status === "queued")) queueMicrotask(() => this.kickQueue());
  }

  listProfiles(projectId: string, includeArchived = false) {
    return this.repository.listIdentityProfiles(projectId, includeArchived);
  }

  describeProfile(id: string) {
    const profile = this.repository.findIdentityProfile(id);
    if (!profile) return null;
    const assessment = this.describeAssessment(profile.assessmentId);
    const executions = this.listExecutions(profile.assessmentId);
    return {
      profile,
      identifiers: this.repository.listIdentityIdentifiers(id),
      assessment,
      tools: this.profileTools(id),
      jobs: this.repository.listSecurityJobs(id),
      assets: this.listAssets(profile.assessmentId),
      observations: this.listObservations(profile.assessmentId),
      relationships: this.listRelationships(profile.assessmentId),
      evidence: executions.flatMap((execution) => this.listEvidence(execution.id)),
    };
  }

  createProfile(input: unknown) {
    const value = CreateIdentityProfileInputSchema.parse(input);
    if (!this.repository.findExecutionNode(value.executionNodeId)) throw new Error(`Execution node ${value.executionNodeId} was not found.`);
    const id = value.id ?? randomUUID();
    const assessmentId = `${id}:assessment`;
    const scopeId = `${id}:scope`;
    const grouped = { email: [] as string[], username: [] as string[], phone: [] as string[], domain: [] as string[], url: [] as string[] };
    for (const identifier of value.identifiers) grouped[identifier.kind].push(identifier.value);
    const scope = createAssessmentScope({
      id: scopeId, allowedEmails: grouped.email, allowedUsernames: grouped.username,
      allowedPhones: grouped.phone, allowedDomains: grouped.domain, allowedUrls: grouped.url,
      authorizationConfirmed: value.authorizationConfirmed,
    });
    const assessment = createSecurityAssessment({
      id: assessmentId, projectId: value.projectId, name: value.displayName,
      mode: value.authorizationConfirmed ? "authorized_assessment" : "osint",
      scopeId, executionNodeId: value.executionNodeId,
    });
    this.repository.saveSecurityAssessmentBundle({ assessment, scope });
    const now = new Date().toISOString();
    const profile = this.repository.saveIdentityProfile(IdentityProfileSchema.parse({
      id, projectId: value.projectId, assessmentId, displayName: value.displayName, notes: value.notes,
      executionNodeId: value.executionNodeId, authorizationConfirmed: value.authorizationConfirmed,
      authorizationConfirmedAt: value.authorizationConfirmed ? now : null, archivedAt: null, createdAt: now, updatedAt: now,
    }));
    for (const identifier of value.identifiers) this.addProfileIdentifier(id, { ...identifier, status: "confirmed", source: "user", confidence: "confirmed" });
    return this.describeProfile(profile.id);
  }

  updateProfile(id: string, input: unknown) {
    const profile = this.repository.findIdentityProfile(id);
    if (!profile) throw new Error(`Identity profile ${id} was not found.`);
    const value = UpdateIdentityProfileInputSchema.parse(input);
    if (value.executionNodeId && !this.repository.findExecutionNode(value.executionNodeId)) throw new Error(`Execution node ${value.executionNodeId} was not found.`);
    const now = new Date().toISOString();
    const confirmed = value.authorizationConfirmed ?? profile.authorizationConfirmed;
    this.repository.saveIdentityProfile({
      ...profile, ...value, authorizationConfirmed: confirmed,
      authorizationConfirmedAt: confirmed ? profile.authorizationConfirmedAt ?? now : null, updatedAt: now,
    });
    const assessment = this.repository.findSecurityAssessment(profile.assessmentId);
    if (assessment && (value.displayName || value.executionNodeId || value.authorizationConfirmed !== undefined)) this.repository.saveSecurityAssessment({
      ...assessment, name: value.displayName ?? assessment.name,
      executionNodeId: value.executionNodeId ?? assessment.executionNodeId,
      mode: value.authorizationConfirmed === undefined ? assessment.mode : confirmed ? "authorized_assessment" : "osint",
      updatedAt: now,
    });
    this.syncProfileScope(id);
    return this.describeProfile(id);
  }

  archiveProfile(id: string, archived = true) {
    const profile = this.repository.findIdentityProfile(id);
    if (!profile) throw new Error(`Identity profile ${id} was not found.`);
    this.repository.saveIdentityProfile({ ...profile, archivedAt: archived ? new Date().toISOString() : null, updatedAt: new Date().toISOString() });
    return this.describeProfile(id);
  }

  addProfileIdentifier(profileId: string, input: unknown) {
    if (!this.repository.findIdentityProfile(profileId)) throw new Error(`Identity profile ${profileId} was not found.`);
    const value = IdentifierInputSchema.extend({
      status: z.enum(["confirmed", "candidate", "rejected"]).default("confirmed"),
      confidence: z.enum(["confirmed", "strong", "possible", "unverified", "conflicting"]).default("confirmed"),
      source: z.enum(["user", "tool"]).default("user"),
      evidenceIds: z.array(z.string()).default([]),
    }).parse(input);
    const normalizedValue = normalizedIdentifier(value.kind, value.value);
    SecurityTargetSchema.parse({ kind: value.kind, value: normalizedValue });
    const existing = this.repository.listIdentityIdentifiers(profileId).find((item) => item.kind === value.kind && item.normalizedValue === normalizedValue);
    const now = new Date().toISOString();
    const identifier = this.repository.saveIdentityIdentifier(IdentityIdentifierSchema.parse({
      id: existing?.id ?? randomUUID(), profileId, ...value, normalizedValue,
      createdAt: existing?.createdAt ?? now, updatedAt: now,
    }));
    this.syncProfileScope(profileId);
    return identifier;
  }

  setProfileIdentifierStatus(profileId: string, identifierId: string, status: IdentityIdentifier["status"]) {
    const identifier = this.repository.findIdentityIdentifier(identifierId);
    if (!identifier || identifier.profileId !== profileId) throw new Error(`Identity identifier ${identifierId} was not found.`);
    const updated = this.repository.saveIdentityIdentifier({
      ...identifier, status, confidence: status === "confirmed" ? "confirmed" : identifier.confidence, updatedAt: new Date().toISOString(),
    });
    this.syncProfileScope(profileId);
    return updated;
  }

  private syncProfileScope(profileId: string) {
    const profile = this.repository.findIdentityProfile(profileId);
    if (!profile) return;
    const assessment = this.repository.findSecurityAssessment(profile.assessmentId);
    const prior = assessment ? this.repository.findAssessmentScope(assessment.scopeId) : null;
    if (!assessment || !prior) return;
    const identifiers = this.repository.listIdentityIdentifiers(profileId);
    const values = (kind: IdentityIdentifier["kind"], status: IdentityIdentifier["status"]) => identifiers.filter((item) => item.kind === kind && item.status === status).map((item) => item.normalizedValue);
    this.repository.saveAssessmentScope({
      ...prior,
      allowedEmails: values("email", "confirmed"), allowedUsernames: values("username", "confirmed"),
      allowedPhones: values("phone", "confirmed"), allowedDomains: values("domain", "confirmed"), allowedUrls: values("url", "confirmed"),
      excludedEmails: values("email", "rejected"), excludedUsernames: values("username", "rejected"),
      excludedPhones: values("phone", "rejected"), excludedDomains: values("domain", "rejected"), excludedUrls: values("url", "rejected"),
      authorizationConfirmed: profile.authorizationConfirmed,
      authorizationConfirmedAt: profile.authorizationConfirmedAt, updatedAt: new Date().toISOString(),
    });
  }

  profileTools(profileId: string) {
    const profile = this.repository.findIdentityProfile(profileId);
    if (!profile) throw new Error(`Identity profile ${profileId} was not found.`);
    const node = this.repository.findExecutionNode(profile.executionNodeId);
    const identifiers = this.repository.listIdentityIdentifiers(profileId).filter((item) => item.status === "confirmed");
    return identifiers.flatMap((identifier) => profileOperations[identifier.kind].map((operation) => {
      const adapter = getSecurityOperationAdapter(operation);
      const capability = node?.capabilities.find((item) => item.id === adapter.requiredCapability);
      const authorized = adapter.classification === "passive" || profile.authorizationConfirmed;
      const validPhone = identifier.kind !== "phone" || /^\+[1-9]\d{7,14}$/.test(identifier.normalizedValue);
      return { operation, identifierId: identifier.id, target: { kind: identifier.kind, value: identifier.normalizedValue }, classification: adapter.classification, capability: adapter.requiredCapability, available: validPhone && authorized && node?.status === "online" && capability?.status === "available", reason: !validPhone ? "Add the phone number with its country code, such as +1 225 249 5700." : !authorized ? "Confirm profile authorization before using active tools." : node?.status !== "online" ? "Execution node is offline." : capability?.status !== "available" ? `${adapter.requiredCapability} is unavailable.` : null };
    }));
  }

  enqueueProfileJob(profileId: string, input: unknown) {
    const value = z.object({ operation: z.string().min(1), identifierId: z.string().min(1) }).parse(input);
    const profile = this.repository.findIdentityProfile(profileId);
    const identifier = this.repository.findIdentityIdentifier(value.identifierId);
    if (!profile || !identifier || identifier.profileId !== profileId || identifier.status !== "confirmed") {
      throw new Error("Only confirmed identifiers on this profile may be used for tool runs.");
    }
    if (!profileOperations[identifier.kind].includes(value.operation)) throw new Error(`${value.operation} does not apply to ${identifier.kind} identifiers.`);
    if (identifier.kind === "phone" && !/^\+[1-9]\d{7,14}$/.test(identifier.normalizedValue)) {
      throw new Error("Phone lookup requires an international number with a country code, such as +1 225 249 5700.");
    }
    const adapter = getSecurityOperationAdapter(value.operation);
    if (adapter.classification !== "passive" && !profile.authorizationConfirmed) throw new Error("Profile authorization must be confirmed before active tools can be queued.");
    const target = SecurityTargetSchema.parse({ kind: identifier.kind, value: identifier.normalizedValue });
    const duplicate = this.repository.listSecurityJobs(profileId).find((job) =>
      ["queued", "awaiting_approval", "running"].includes(job.status)
      && job.operation === value.operation && job.target.kind === target.kind && job.target.value === target.value
    );
    if (duplicate) return duplicate;
    const id = randomUUID();
    const executionId = `${id}:execution`;
    const planned = this.planExecution({
      id: executionId, operationId: `${id}:operation`, assessmentId: profile.assessmentId,
      taskId: `profile-job:${id}`, workflowVersion: 1, operation: value.operation,
      classification: adapter.classification, targets: [target],
    });
    const approvalRequired = planned.toolDecision.approvalRequirement !== "none";
    if (!approvalRequired) this.setExecutionStatus(executionId, "approved");
    const now = new Date().toISOString();
    const job = this.repository.saveSecurityJob({
      id, profileId, assessmentId: profile.assessmentId, executionId, nodeId: profile.executionNodeId,
      operation: value.operation, target, status: approvalRequired ? "awaiting_approval" : "queued",
      approvalRequired, error: null, createdAt: now, updatedAt: now, startedAt: null, completedAt: null,
    });
    if (!approvalRequired) this.kickQueue();
    return job;
  }

  enqueuePassiveSuite(profileId: string) {
    const jobs = this.profileTools(profileId)
      .filter((tool) => tool.classification === "passive" && tool.available && tool.operation !== "maigret_full_username_search")
      .map((tool) => this.enqueueProfileJob(profileId, { operation: tool.operation, identifierId: tool.identifierId }));
    return { jobs };
  }

  approveProfileJob(id: string) {
    const job = this.repository.findSecurityJob(id);
    if (!job || job.status !== "awaiting_approval") throw new Error(`Security job ${id} is not awaiting approval.`);
    this.setExecutionStatus(job.executionId, "approved");
    const updated = this.repository.saveSecurityJob({ ...job, status: "queued", updatedAt: new Date().toISOString() });
    this.kickQueue();
    return updated;
  }

  cancelProfileJob(id: string) {
    const job = this.repository.findSecurityJob(id);
    if (!job) throw new Error(`Security job ${id} was not found.`);
    if (job.status === "running") this.cancelExecution(job.executionId);
    if (!["queued", "awaiting_approval", "running"].includes(job.status)) return job;
    const execution = this.getExecution(job.executionId);
    if (execution && execution.status !== "running") this.setExecutionStatus(job.executionId, "cancelled", { cancelled: true });
    return this.repository.saveSecurityJob({ ...job, status: "cancelled", completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  }

  private kickQueue() {
    if (this.queueRunning) return;
    this.queueRunning = true;
    queueMicrotask(() => { void this.drainQueue(); });
  }

  private async drainQueue() {
    try {
      while (true) {
        const job = this.repository.listSecurityJobs().filter((item) => item.status === "queued").sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
        if (!job) break;
        const now = new Date().toISOString();
        this.repository.saveSecurityJob({ ...job, status: "running", startedAt: now, updatedAt: now });
        try {
          const output = await this.executeApprovedOperation(job.executionId);
          const latest = this.repository.findSecurityJob(job.id);
          const status = latest?.status === "cancelled" ? "cancelled" : output.execution.status === "succeeded" ? "succeeded" : output.execution.status === "cancelled" ? "cancelled" : "failed";
          const completed = this.repository.saveSecurityJob({ ...(latest ?? job), status, startedAt: now, completedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), error: output.execution.error });
          if (status === "succeeded") this.captureProfileCandidates(completed.profileId, output.normalized, output.evidence.find((item) => item.kind === "normalized")?.id ?? null);
        } catch (error) {
          this.repository.saveSecurityJob({ ...job, status: "failed", startedAt: now, completedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), error: error instanceof Error ? error.message : "Security job failed." });
        }
      }
    } finally {
      this.queueRunning = false;
      if (this.repository.listSecurityJobs().some((item) => item.status === "queued")) this.kickQueue();
    }
  }

  private captureProfileCandidates(profileId: string, normalized: unknown, evidenceId: string | null) {
    if (!normalized || typeof normalized !== "object") return;
    const value = normalized as { profiles?: unknown };
    const urls = (Array.isArray(value.profiles) ? value.profiles : [])
      .filter((item): item is string => typeof item === "string" && /^https?:\/\//i.test(item));
    for (const url of [...new Set(urls)]) this.addProfileIdentifier(profileId, {
      kind: "url", value: url, status: "candidate", source: "tool", confidence: "possible", evidenceIds: evidenceId ? [evidenceId] : [],
    });
  }

  resumeProfileQueue() {
    this.kickQueue();
  }

  listNodes(): ExecutionNode[] {
    return this.repository.listExecutionNodes();
  }

  listTools(nodeId?: string | null) {
    if (!nodeId) return securityToolStatuses();
    const node = this.repository.findExecutionNode(nodeId);
    if (!node) throw new Error(`Execution node ${nodeId} was not found.`);
    return securityToolStatuses(node);
  }

  registerNode(input: unknown): ExecutionNode {
    const value = RegisterExecutionNodeInputSchema.parse(input);
    const existing = this.repository.listExecutionNodes().find((node) =>
      node.provider === value.provider
      && node.host?.toLowerCase() === value.host?.toLowerCase()
      && node.port === (value.port ?? 22)
      && node.username?.toLowerCase() === value.username?.toLowerCase()
    );
    if (existing) {
      return this.repository.saveExecutionNode({
        ...existing,
        name: value.name,
        workingDirectory: value.workingDirectory ?? existing.workingDirectory,
        credentialRef: value.credentialRef ?? existing.credentialRef,
        securityRuntime: value.securityRuntime,
        updatedAt: new Date().toISOString(),
      });
    }
    const id = value.id ?? randomUUID();
    if (this.repository.findExecutionNode(id)) {
      throw new Error(`Execution node ${id} already exists.`);
    }

    const node = createExecutionNode({
      id,
      name: value.name,
      provider: value.provider,
      host: value.host ?? null,
      port: value.port ?? 22,
      username: value.username ?? null,
      workingDirectory: value.workingDirectory ?? null,
      credentialRef: value.credentialRef ?? null,
      securityRuntime: value.securityRuntime,
    });
    return this.repository.saveExecutionNode(node);
  }

  deleteNode(id: string): boolean {
    return this.repository.deleteExecutionNode(id);
  }

  async refreshNode(id: string): Promise<ExecutionNode> {
    const node = this.repository.findExecutionNode(id);
    if (!node) throw new Error(`Execution node ${id} was not found.`);
    if (node.provider !== this.sshProvider.kind) {
      throw new Error(`No ${node.provider} execution provider is configured for node ${id}.`);
    }

    const refreshed = await refreshExecutionNode(node, this.sshProvider);
    if (refreshed.status !== "online" || refreshed.securityRuntime !== "kali_mcp") {
      return this.repository.saveExecutionNode(refreshed);
    }
    try {
      const health = await this.kaliMcpProvider.healthCheck(refreshed);
      return this.repository.saveExecutionNode({
        ...refreshed,
        mcpServerName: health.serverName,
        mcpServerVersion: health.serverVersion,
        mcpTools: health.tools.map((tool) => tool.name).sort(),
        lastError: null,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      return this.repository.saveExecutionNode({
        ...refreshed,
        status: "error",
        mcpServerName: null,
        mcpServerVersion: null,
        mcpTools: [],
        lastError: error instanceof Error ? error.message : "Kali MCP health check failed.",
        updatedAt: new Date().toISOString(),
      });
    }
  }

  createInstallPlan(id: string, toolIds: string[]) {
    const node = this.repository.findExecutionNode(id);
    if (!node) throw new Error(`Execution node ${id} was not found.`);
    return createSecurityInstallPlan(node, toolIds);
  }

  async executeInstallPlan(id: string, input: unknown) {
    const value = z.object({
      approved: z.literal(true),
      plan: SecurityInstallPlanSchema,
    }).parse(input);
    if (value.plan.nodeId !== id) throw new Error("Installation plan targets a different execution node.");
    const node = this.repository.findExecutionNode(id);
    if (!node) throw new Error(`Execution node ${id} was not found.`);
    const command = installCommand(value.plan);
    if (!command) return { plan: value.plan, result: null, node };
    const result = await this.sshProvider.execute(node, createExecutionRequest({
      nodeId: node.id,
      executable: command.executable,
      args: command.args,
      timeoutMs: 15 * 60 * 1000,
    }));
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `Package installation exited with code ${result.exitCode ?? "unknown"}.`);
    }
    return { plan: value.plan, result, node: await this.refreshNode(id) };
  }

  listAssessments(projectId: string) {
    return this.repository.listSecurityAssessments(projectId);
  }

  listCases(projectId: string) {
    const profileAssessmentIds = new Set(this.repository.listIdentityProfiles(projectId, true).map((profile) => profile.assessmentId));
    return this.repository.listSecurityAssessments(projectId).filter((assessment) => !profileAssessmentIds.has(assessment.id));
  }

  createInvestigationPlan(assessmentId: string, input: unknown) {
    const value = CreateSecurityInvestigationPlanInputSchema.omit({ id: true, assessmentId: true }).parse(input);
    const described = this.describeAssessment(assessmentId);
    if (!described || !described.scope) throw new Error(`Security assessment ${assessmentId} is missing its durable scope.`);
    if (!described.executionNode) throw new Error(`Security assessment ${assessmentId} has no execution node.`);
    const plan = createSecurityInvestigationPlan({
      id: randomUUID(), assessmentId, ...value, assessment: described.assessment, scope: described.scope,
      node: described.executionNode, createId: randomUUID,
    });
    return this.repository.saveSecurityInvestigationPlan(plan);
  }

  listInvestigationPlans(assessmentId: string) {
    if (!this.repository.findSecurityAssessment(assessmentId)) throw new Error(`Security assessment ${assessmentId} was not found.`);
    return this.repository.listSecurityInvestigationPlans(assessmentId);
  }

  getInvestigationPlan(id: string) {
    return this.repository.findSecurityInvestigationPlan(id);
  }

  createAssessment(input: unknown) {
    const value = CreateSecurityAssessmentInputSchema.parse(input);
    if (value.executionNodeId && !this.repository.findExecutionNode(value.executionNodeId)) {
      throw new Error(`Execution node ${value.executionNodeId} was not found.`);
    }

    const assessmentId = value.id ?? randomUUID();
    if (this.repository.findSecurityAssessment(assessmentId)) {
      throw new Error(`Security assessment ${assessmentId} already exists.`);
    }

    const scope = createAssessmentScope({
      id: `${assessmentId}:scope`,
      ...value.scope,
    });
    const assessment = createSecurityAssessment({
      id: assessmentId,
      projectId: value.projectId,
      name: value.name,
      mode: value.mode,
      scopeId: scope.id,
      executionNodeId: value.executionNodeId ?? null,
    });
    this.repository.saveSecurityAssessmentBundle({ assessment, scope });
    return { assessment, scope };
  }

  describeAssessment(id: string) {
    const assessment = this.repository.findSecurityAssessment(id);
    if (!assessment) return null;
    return {
      assessment,
      scope: this.repository.findAssessmentScope(assessment.scopeId),
      executionNode: assessment.executionNodeId
        ? this.repository.findExecutionNode(assessment.executionNodeId)
        : null,
    };
  }

  setAssessmentStatus(id: string, status: SecurityAssessment["status"]) {
    const assessment = this.repository.findSecurityAssessment(id);
    if (!assessment) throw new Error(`Security assessment ${id} was not found.`);
    return this.repository.saveSecurityAssessment({
      ...assessment,
      status,
      updatedAt: new Date().toISOString(),
    });
  }

  planExecution(input: unknown) {
    const value = PlanSecurityExecutionInputSchema.parse(input);
    const described = this.describeAssessment(value.assessmentId);
    if (!described || !described.scope) {
      throw new Error(`Security assessment ${value.assessmentId} is missing its durable scope.`);
    }
    if (!described.executionNode) {
      throw new Error(`Security assessment ${value.assessmentId} has no execution node.`);
    }

    const adapter = getSecurityOperationAdapter(value.operation);
    const toolId = value.toolId ?? adapter.requiredCapability;
    if (adapter.requiredCapability !== toolId) {
      throw new Error(`Security operation ${value.operation} requires tool ${adapter.requiredCapability}, not ${toolId}.`);
    }
    if (adapter.classification !== value.classification) {
      throw new Error(`Security operation ${value.operation} must be classified as ${adapter.classification}.`);
    }
    const toolDecision = decideSecurityToolRequest({
      assessment: described.assessment,
      scope: described.scope,
      node: described.executionNode,
      toolId,
      operationId: value.operation,
      targets: value.targets,
    });
    if (!toolDecision.allowed || !toolDecision.tool) {
      throw new Error(`Security tool request rejected: ${toolDecision.reason}`);
    }

    const decision = assertSecurityOperationAuthorized({
      assessment: described.assessment,
      scope: described.scope,
      request: {
        operation: value.operation,
        classification: value.classification,
        targets: value.targets,
      },
    });

    const operationId = value.operationId ?? randomUUID();
    const toolRequest = createSecurityToolRequest({
      id: value.id ? `${value.id}:tool-request` : randomUUID(),
      assessmentId: described.assessment.id,
      toolId,
      operationId,
      purpose: value.purpose ?? `Run ${value.operation} against the explicitly scoped target.`,
      arguments: value.arguments ?? {},
      targets: value.targets,
      expectedEvidence: value.expectedEvidence ?? toolDecision.tool.evidenceKinds,
      risk: toolDecision.tool.defaultRisk,
      approvalRequirement: toolDecision.approvalRequirement,
    });
    const execution = createSecurityExecutionRecord({
      id: value.id ?? randomUUID(),
      assessmentId: described.assessment.id,
      taskId: value.taskId,
      workflowVersion: value.workflowVersion,
      nodeId: described.executionNode.id,
      operationId,
      operation: value.operation,
      classification: value.classification,
      targets: value.targets,
      provider: described.executionNode.provider,
      transport: described.executionNode.securityRuntime,
      mcpTool: adapter.buildMcpInvocation(adapter.validate(value.targets)).mcpTool,
      underlyingExecutable: adapter.buildMcpInvocation(adapter.validate(value.targets)).underlyingExecutable,
      toolRequest,
    });
    this.repository.saveSecurityExecution(execution);
    return { execution, decision, toolDecision };
  }

  getExecution(id: string): SecurityExecutionRecord | null {
    return this.repository.findSecurityExecution(id);
  }

  listExecutions(assessmentId: string): SecurityExecutionRecord[] {
    return this.repository.listSecurityExecutions(assessmentId);
  }

  setExecutionStatus(
    id: string,
    status: (typeof securityExecutionStatuses)[number],
    patch: Partial<Pick<SecurityExecutionRecord, "startedAt" | "completedAt" | "exitCode" | "timedOut" | "cancelled" | "error">> = {},
  ): SecurityExecutionRecord {
    const execution = this.repository.findSecurityExecution(id);
    if (!execution) throw new Error(`Security execution ${id} was not found.`);
    const now = new Date().toISOString();
    return this.repository.saveSecurityExecution({
      ...execution,
      ...patch,
      status,
      startedAt: status === "running" && !patch.startedAt ? now : patch.startedAt ?? execution.startedAt,
      completedAt: ["succeeded", "failed", "cancelled", "blocked"].includes(status) && !patch.completedAt
        ? now
        : patch.completedAt ?? execution.completedAt,
      updatedAt: now,
    });
  }

  deleteExecution(id: string): boolean {
    return this.repository.deleteSecurityExecution(id);
  }

  recordEvidence(input: unknown) {
    const value = RecordSecurityEvidenceInputSchema.parse(input);
    const execution = this.repository.findSecurityExecution(value.executionId);
    if (!execution) throw new Error(`Security execution ${value.executionId} was not found.`);
    const evidence = createSecurityEvidenceRecord({
      id: value.id ?? randomUUID(),
      assessmentId: execution.assessmentId,
      executionId: execution.id,
      taskId: execution.taskId,
      kind: value.kind,
      contentType: value.contentType,
      text: value.text,
      truncated: value.truncated,
      storageUri: value.storageUri,
    });
    return this.repository.saveSecurityEvidence(evidence);
  }

  listEvidence(executionId: string) {
    return this.repository.listSecurityEvidence(executionId);
  }

  listAssets(assessmentId: string) {
    return this.repository.listSecurityAssets(assessmentId);
  }

  describeAsset(assessmentId: string, assetId: string) {
    const asset = this.repository.findSecurityAsset(assetId);
    if (!asset || asset.assessmentId !== assessmentId) return null;
    return {
      asset,
      services: this.repository.listSecurityServices(assessmentId, assetId),
      observations: this.repository.listSecurityObservations(assessmentId, assetId),
      relationships: this.repository.listSecurityRelationships(assessmentId, assetId),
    };
  }

  listServices(assessmentId: string) {
    return this.repository.listSecurityServices(assessmentId);
  }

  listObservations(assessmentId: string) {
    return this.repository.listSecurityObservations(assessmentId);
  }

  listRelationships(assessmentId: string) {
    return this.repository.listSecurityRelationships(assessmentId);
  }

  readCase(assessmentId: string) {
    const described = this.describeAssessment(assessmentId);
    if (!described) throw new Error(`Security assessment ${assessmentId} was not found.`);
    const executions = this.listExecutions(assessmentId);
    return {
      ...described,
      executions,
      assets: this.listAssets(assessmentId),
      services: this.listServices(assessmentId),
      observations: this.listObservations(assessmentId),
      relationships: this.listRelationships(assessmentId),
      evidence: executions.flatMap((execution) => this.listEvidence(execution.id)),
    };
  }

  private ingestNormalizedResult(
    execution: SecurityExecutionRecord,
    evidenceId: string,
    normalized: unknown,
  ): void {
    const observedAt = new Date().toISOString();
    const existingAssets = new Map(this.repository.listSecurityAssets(execution.assessmentId).map((asset) => [asset.id, asset]));
    const existingServices = new Map(this.repository.listSecurityServices(execution.assessmentId).map((service) => [service.id, service]));
    const existingRelationships = new Map(this.repository.listSecurityRelationships(execution.assessmentId).map((relationship) => [relationship.id, relationship]));
    const assets = new Map<string, SecurityAsset>();
    const services = new Map<string, SecurityNetworkService>();
    const observations: SecurityObservation[] = [];
    const relationships = new Map<string, SecurityRelationship>();

    const asset = (kind: SecurityAsset["kind"], keyInput: string, displayName = keyInput) => {
      const key = kind === "domain" ? cleanDomain(keyInput) : keyInput.trim().toLowerCase();
      const id = stableSecurityId("asset", execution.assessmentId, kind, key);
      const prior = existingAssets.get(id);
      const value: SecurityAsset = {
        id,
        assessmentId: execution.assessmentId,
        kind,
        key,
        displayName: displayName.trim().replace(/\.$/, ""),
        firstSeenAt: prior?.firstSeenAt ?? observedAt,
        lastSeenAt: observedAt,
        lastExecutionId: execution.id,
        lastEvidenceId: evidenceId,
      };
      assets.set(id, value);
      return value;
    };

    if (execution.operation === "dns_lookup") {
      const value = z.object({
        operation: z.literal("dns_lookup"),
        domain: z.string().min(1),
        records: z.array(z.object({
          name: z.string().min(1), ttl: z.number().int().nonnegative(), class: z.string().min(1),
          type: z.string().min(1), value: z.string().min(1),
        })),
      }).parse(normalized);
      const queriedDomain = asset("domain", value.domain);
      value.records.forEach((record, index) => {
        const owner = asset("domain", record.name);
        observations.push({
          id: stableSecurityId("observation", execution.id, "dns_record", index),
          assessmentId: execution.assessmentId,
          assetId: owner.id,
          serviceId: null,
          executionId: execution.id,
          evidenceId,
          type: "dns_record",
          data: record,
          observedAt,
        });
        if (record.type === "A" || record.type === "AAAA") {
          const address = asset("ip_address", record.value);
          const id = stableSecurityId("relationship", execution.assessmentId, owner.id, address.id, "resolves_to");
          const prior = existingRelationships.get(id);
          relationships.set(id, {
            id, assessmentId: execution.assessmentId, sourceAssetId: owner.id, targetAssetId: address.id,
            kind: "resolves_to", firstSeenAt: prior?.firstSeenAt ?? observedAt, lastSeenAt: observedAt,
            confidence: "confirmed", rationale: "DNS answer directly associated the name with this address.",
            evidenceIds: [...new Set([...(prior?.evidenceIds ?? []), evidenceId])],
            lastExecutionId: execution.id, lastEvidenceId: evidenceId,
          });
        } else if (record.type === "CNAME") {
          const alias = asset("domain", record.value);
          const id = stableSecurityId("relationship", execution.assessmentId, owner.id, alias.id, "aliases_to");
          const prior = existingRelationships.get(id);
          relationships.set(id, {
            id, assessmentId: execution.assessmentId, sourceAssetId: owner.id, targetAssetId: alias.id,
            kind: "aliases_to", firstSeenAt: prior?.firstSeenAt ?? observedAt, lastSeenAt: observedAt,
            confidence: "confirmed", rationale: "DNS CNAME directly identified this alias.",
            evidenceIds: [...new Set([...(prior?.evidenceIds ?? []), evidenceId])],
            lastExecutionId: execution.id, lastEvidenceId: evidenceId,
          });
        }
      });
      assets.set(queriedDomain.id, assets.get(queriedDomain.id) ?? queriedDomain);
    } else if (execution.operation === "service_inventory") {
      const value = z.object({
        operation: z.literal("service_inventory"),
        host: z.string().min(1),
        services: z.array(z.object({
          port: z.number().int().min(1).max(65535), protocol: z.string().min(1), state: z.string().min(1),
          service: z.string().min(1), product: z.string().nullable(), version: z.string().nullable(),
        })),
      }).parse(normalized);
      const host = asset("host", value.host);
      value.services.forEach((found, index) => {
        const id = stableSecurityId("service", execution.assessmentId, host.id, found.protocol, found.port);
        const prior = existingServices.get(id);
        const service: SecurityNetworkService = {
          id, assessmentId: execution.assessmentId, assetId: host.id, port: found.port,
          protocol: found.protocol, state: found.state, name: found.service,
          product: found.product, version: found.version,
          firstSeenAt: prior?.firstSeenAt ?? observedAt, lastSeenAt: observedAt,
          lastExecutionId: execution.id, lastEvidenceId: evidenceId,
        };
        services.set(id, service);
        observations.push({
          id: stableSecurityId("observation", execution.id, "service", index),
          assessmentId: execution.assessmentId, assetId: host.id, serviceId: id,
          executionId: execution.id, evidenceId, type: "service_observed", data: found, observedAt,
        });
      });
    } else if (execution.operation === "arp_scan_discovery") {
      const value = z.object({ operation: z.literal("arp_scan_discovery"), network: z.string().min(1), hosts: z.array(z.object({ address: z.string().min(1), mac: z.string().min(1), vendor: z.string().nullable() })) }).parse(normalized);
      const network = asset("network", value.network);
      value.hosts.forEach((found, index) => {
        const host = asset("ip_address", found.address);
        const relationshipId = stableSecurityId("relationship", execution.assessmentId, network.id, host.id, "contains_host");
        const prior = existingRelationships.get(relationshipId);
        relationships.set(relationshipId, { id: relationshipId, assessmentId: execution.assessmentId, sourceAssetId: network.id, targetAssetId: host.id, kind: "contains_host", confidence: "confirmed", rationale: "An ARP response directly identified this address on the authorized local network.", evidenceIds: [...new Set([...(prior?.evidenceIds ?? []), evidenceId])], firstSeenAt: prior?.firstSeenAt ?? observedAt, lastSeenAt: observedAt, lastExecutionId: execution.id, lastEvidenceId: evidenceId });
        observations.push({ id: stableSecurityId("observation", execution.id, "arp_host", index), assessmentId: execution.assessmentId, assetId: host.id, serviceId: null, executionId: execution.id, evidenceId, type: "arp_host", data: found, observedAt });
      });
    } else if (execution.operation === "fping_reachability") {
      const value = z.object({ operation: z.literal("fping_reachability"), target: z.string().min(1), alive: z.array(z.string().min(1)) }).parse(normalized);
      value.alive.forEach((address, index) => {
        const host = asset("ip_address", address);
        observations.push({ id: stableSecurityId("observation", execution.id, "host_reachable", index), assessmentId: execution.assessmentId, assetId: host.id, serviceId: null, executionId: execution.id, evidenceId, type: "host_reachable", data: { target: value.target }, observedAt });
      });
    } else if (execution.operation === "ike_service_probe") {
      const value = z.object({ operation: z.literal("ike_service_probe"), host: z.string().min(1), responders: z.array(z.object({ address: z.string().min(1), summary: z.string().min(1) })) }).parse(normalized);
      value.responders.forEach((responder, index) => {
        const host = asset("ip_address", responder.address);
        const id = stableSecurityId("service", execution.assessmentId, host.id, "udp", 500);
        const prior = existingServices.get(id);
        services.set(id, { id, assessmentId: execution.assessmentId, assetId: host.id, port: 500, protocol: "udp", state: "open", name: "isakmp", product: null, version: null, firstSeenAt: prior?.firstSeenAt ?? observedAt, lastSeenAt: observedAt, lastExecutionId: execution.id, lastEvidenceId: evidenceId });
        observations.push({ id: stableSecurityId("observation", execution.id, "ike_response", index), assessmentId: execution.assessmentId, assetId: host.id, serviceId: id, executionId: execution.id, evidenceId, type: "ike_response", data: responder, observedAt });
      });
    } else if (["enum4linux_host_audit", "smb_anonymous_share_list", "smbmap_anonymous"].includes(execution.operation)) {
      const value = z.object({ operation: z.enum(["enum4linux_host_audit", "smb_anonymous_share_list", "smbmap_anonymous"]), host: z.string().min(1), shares: z.array(z.object({ name: z.string().min(1), type: z.string().nullable(), comment: z.string().nullable(), permissions: z.string().nullable().optional() })), observations: z.array(z.string()).optional() }).parse(normalized);
      const host = asset("host", value.host);
      value.shares.forEach((share, index) => observations.push({ id: stableSecurityId("observation", execution.id, `${value.operation}_share`, index), assessmentId: execution.assessmentId, assetId: host.id, serviceId: null, executionId: execution.id, evidenceId, type: "smb_share", data: { ...share, source: value.operation }, observedAt }));
      (value.observations ?? []).forEach((message, index) => observations.push({ id: stableSecurityId("observation", execution.id, `${value.operation}_detail`, index), assessmentId: execution.assessmentId, assetId: host.id, serviceId: null, executionId: execution.id, evidenceId, type: "smb_observation", data: { message, source: value.operation }, observedAt }));
      if (value.shares.length === 0 && (value.observations ?? []).length === 0) observations.push({ id: stableSecurityId("observation", execution.id, value.operation, 0), assessmentId: execution.assessmentId, assetId: host.id, serviceId: null, executionId: execution.id, evidenceId, type: value.operation, data: { shares: [] }, observedAt });
    } else if (execution.operation === "domain_recon") {
      const value = z.object({
        operation: z.literal("domain_recon"), domain: z.string().min(1), records: z.array(z.unknown()),
      }).parse(normalized);
      const domain = asset("domain", value.domain);
      observations.push({
        id: stableSecurityId("observation", execution.id, "domain_recon", 0),
        assessmentId: execution.assessmentId, assetId: domain.id, serviceId: null,
        executionId: execution.id, evidenceId, type: "domain_recon",
        data: { records: value.records }, observedAt,
      });
    } else if (["public_username_search", "maigret_username_search", "maigret_full_username_search"].includes(execution.operation)) {
      const value = z.object({
        operation: z.enum(["public_username_search", "maigret_username_search", "maigret_full_username_search"]),
        username: z.string().min(1),
        profiles: z.array(z.string().url()),
      }).parse(normalized);
      const username = asset("username", value.username);
      value.profiles.forEach((profileUrl, index) => {
        const profile = asset("profile", profileUrl);
        const relationshipId = stableSecurityId("relationship", execution.assessmentId, username.id, profile.id, "has_profile");
        const prior = existingRelationships.get(relationshipId);
        relationships.set(relationshipId, {
          id: relationshipId, assessmentId: execution.assessmentId, sourceAssetId: username.id, targetAssetId: profile.id,
          kind: "has_profile", confidence: "unverified",
          rationale: `${execution.operation === "public_username_search" ? "Sherlock" : execution.operation === "maigret_full_username_search" ? "Maigret full scan" : "Maigret"} found a public profile candidate; identity ownership still requires corroboration.`,
          evidenceIds: [...new Set([...(prior?.evidenceIds ?? []), evidenceId])],
          firstSeenAt: prior?.firstSeenAt ?? observedAt, lastSeenAt: observedAt,
          lastExecutionId: execution.id, lastEvidenceId: evidenceId,
        });
        observations.push({
          id: stableSecurityId("observation", execution.id, "profile_candidate", index),
          assessmentId: execution.assessmentId, assetId: profile.id, serviceId: null,
          executionId: execution.id, evidenceId, type: "profile_candidate",
          data: { username: value.username, profileUrl, source: execution.operation }, observedAt,
        });
      });
    } else if (execution.operation === "public_email_search" || execution.operation === "email_account_search") {
      const value = z.object({
        operation: z.enum(["public_email_search", "email_account_search"]),
        email: z.string().email(),
        references: z.array(z.string()).optional(),
        services: z.array(z.string()).optional(),
      }).parse(normalized);
      const email = asset("email", value.email);
      const domainName = value.email.slice(value.email.lastIndexOf("@") + 1);
      const domain = asset("domain", domainName);
      const relationshipId = stableSecurityId("relationship", execution.assessmentId, email.id, domain.id, "uses_domain");
      const prior = existingRelationships.get(relationshipId);
      relationships.set(relationshipId, {
        id: relationshipId, assessmentId: execution.assessmentId, sourceAssetId: email.id, targetAssetId: domain.id,
        kind: "uses_domain", confidence: "confirmed", rationale: "The domain is part of the authorized email address.",
        evidenceIds: [...new Set([...(prior?.evidenceIds ?? []), evidenceId])],
        firstSeenAt: prior?.firstSeenAt ?? observedAt, lastSeenAt: observedAt,
        lastExecutionId: execution.id, lastEvidenceId: evidenceId,
      });
      observations.push({
        id: stableSecurityId("observation", execution.id, value.operation, 0),
        assessmentId: execution.assessmentId, assetId: email.id, serviceId: null,
        executionId: execution.id, evidenceId, type: value.operation,
        data: { references: value.references ?? [], services: value.services ?? [] }, observedAt,
      });
    } else if (execution.operation === "phone_enrichment") {
      const value = z.object({
        operation: z.literal("phone_enrichment"), phone: z.string().min(1),
        details: z.record(z.string(), z.unknown()), references: z.array(z.string()),
      }).parse(normalized);
      const phone = asset("phone", value.phone);
      observations.push({
        id: stableSecurityId("observation", execution.id, "phone_enrichment", 0),
        assessmentId: execution.assessmentId, assetId: phone.id, serviceId: null,
        executionId: execution.id, evidenceId, type: "phone_enrichment",
        data: { details: value.details, references: value.references }, observedAt,
      });
    } else if (execution.operation === "web_fingerprint" || execution.operation === "web_content_discovery") {
      const value = z.object({
        operation: z.enum(["web_fingerprint", "web_content_discovery"]), url: z.string().url(),
        technologies: z.array(z.string()).optional(), paths: z.array(z.string()).optional(),
      }).parse(normalized);
      const url = asset("url", value.url);
      observations.push({
        id: stableSecurityId("observation", execution.id, value.operation, 0),
        assessmentId: execution.assessmentId, assetId: url.id, serviceId: null,
        executionId: execution.id, evidenceId, type: value.operation,
        data: { technologies: value.technologies ?? [], paths: value.paths ?? [] }, observedAt,
      });
    } else if (execution.operation === "whois_lookup") {
      const value = z.object({ operation: z.literal("whois_lookup"), domain: z.string().min(1), fields: z.record(z.string(), z.array(z.string())) }).parse(normalized);
      const domain = asset("domain", value.domain);
      observations.push({ id: stableSecurityId("observation", execution.id, "whois_lookup", 0), assessmentId: execution.assessmentId, assetId: domain.id, serviceId: null, executionId: execution.id, evidenceId, type: "whois_lookup", data: { fields: value.fields }, observedAt });
    } else if (["dnsenum_discovery", "dnsmap_discovery", "fierce_discovery", "amass_passive_discovery", "dmitry_domain_intel"].includes(execution.operation)) {
      const value = z.object({
        operation: z.enum(["dnsenum_discovery", "dnsmap_discovery", "fierce_discovery", "amass_passive_discovery", "dmitry_domain_intel"]),
        domain: z.string().min(1),
        hosts: z.array(z.object({ name: z.string().min(1), address: z.string().nullable() })),
        emails: z.array(z.string().email()),
      }).parse(normalized);
      const domain = asset("domain", value.domain);
      value.hosts.forEach((host, index) => {
        const hostAsset = asset("domain", host.name);
        const relationshipId = stableSecurityId("relationship", execution.assessmentId, domain.id, hostAsset.id, "has_subdomain");
        const prior = existingRelationships.get(relationshipId);
        relationships.set(relationshipId, {
          id: relationshipId, assessmentId: execution.assessmentId, sourceAssetId: domain.id, targetAssetId: hostAsset.id,
          kind: "has_subdomain", confidence: "unverified", rationale: `${value.operation.replaceAll("_", " ")} discovered this hostname.`,
          evidenceIds: [...new Set([...(prior?.evidenceIds ?? []), evidenceId])], firstSeenAt: prior?.firstSeenAt ?? observedAt,
          lastSeenAt: observedAt, lastExecutionId: execution.id, lastEvidenceId: evidenceId,
        });
        observations.push({
          id: stableSecurityId("observation", execution.id, value.operation, index), assessmentId: execution.assessmentId,
          assetId: hostAsset.id, serviceId: null, executionId: execution.id, evidenceId, type: value.operation,
          data: { rootDomain: value.domain, hostname: host.name, address: host.address }, observedAt,
        });
      });
      value.emails.forEach((emailValue, index) => {
        const email = asset("email", emailValue);
        observations.push({ id: stableSecurityId("observation", execution.id, `${value.operation}_email`, index), assessmentId: execution.assessmentId, assetId: email.id, serviceId: null, executionId: execution.id, evidenceId, type: "public_email_candidate", data: { domain: value.domain, source: value.operation }, observedAt });
      });
      if (value.hosts.length === 0 && value.emails.length === 0) {
        observations.push({ id: stableSecurityId("observation", execution.id, value.operation, 0), assessmentId: execution.assessmentId, assetId: domain.id, serviceId: null, executionId: execution.id, evidenceId, type: value.operation, data: { hosts: [], emails: [] }, observedAt });
      }
    } else if (execution.operation === "waf_detection") {
      const value = z.object({ operation: z.literal("waf_detection"), url: z.string().url(), detected: z.boolean(), products: z.array(z.object({ firewall: z.string(), manufacturer: z.string().nullable(), triggerUrl: z.string().nullable() })) }).parse(normalized);
      const url = asset("url", value.url);
      observations.push({ id: stableSecurityId("observation", execution.id, "waf_detection", 0), assessmentId: execution.assessmentId, assetId: url.id, serviceId: null, executionId: execution.id, evidenceId, type: "waf_detection", data: { detected: value.detected, products: value.products }, observedAt });
    } else if (execution.operation === "tls_configuration") {
      const value = z.object({ operation: z.literal("tls_configuration"), url: z.string().url(), connectivity: z.string().nullable(), scanStatus: z.string().nullable(), certificateDeployments: z.number().int().nonnegative(), compliance: z.string().nullable() }).parse(normalized);
      const url = asset("url", value.url);
      observations.push({ id: stableSecurityId("observation", execution.id, "tls_configuration", 0), assessmentId: execution.assessmentId, assetId: url.id, serviceId: null, executionId: execution.id, evidenceId, type: "tls_configuration", data: value, observedAt });
    } else if (execution.operation === "sslscan_configuration") {
      const value = z.object({ operation: z.literal("sslscan_configuration"), url: z.string().url(), protocols: z.array(z.string()), ciphers: z.array(z.string()), certificateSubjects: z.array(z.string()) }).parse(normalized);
      const url = asset("url", value.url);
      observations.push({ id: stableSecurityId("observation", execution.id, value.operation, 0), assessmentId: execution.assessmentId, assetId: url.id, serviceId: null, executionId: execution.id, evidenceId, type: value.operation, data: { protocols: value.protocols, ciphers: value.ciphers, certificateSubjects: value.certificateSubjects }, observedAt });
    } else if (["ffuf_content_discovery", "dirb_content_discovery", "wfuzz_content_discovery"].includes(execution.operation)) {
      const value = z.object({ operation: z.enum(["ffuf_content_discovery", "dirb_content_discovery", "wfuzz_content_discovery"]), url: z.string().url(), paths: z.array(z.object({ url: z.string().url(), status: z.number().int().nullable(), length: z.number().int().nullable() })) }).parse(normalized);
      const rootUrl = asset("url", value.url);
      value.paths.forEach((path, index) => {
        const pathAsset = asset("url", path.url);
        const relationshipId = stableSecurityId("relationship", execution.assessmentId, rootUrl.id, pathAsset.id, "contains_path");
        const prior = existingRelationships.get(relationshipId);
        relationships.set(relationshipId, { id: relationshipId, assessmentId: execution.assessmentId, sourceAssetId: rootUrl.id, targetAssetId: pathAsset.id, kind: "contains_path", confidence: "confirmed", rationale: `${value.operation.replaceAll("_", " ")} observed an HTTP response for this path.`, evidenceIds: [...new Set([...(prior?.evidenceIds ?? []), evidenceId])], firstSeenAt: prior?.firstSeenAt ?? observedAt, lastSeenAt: observedAt, lastExecutionId: execution.id, lastEvidenceId: evidenceId });
        observations.push({ id: stableSecurityId("observation", execution.id, value.operation, index), assessmentId: execution.assessmentId, assetId: pathAsset.id, serviceId: null, executionId: execution.id, evidenceId, type: value.operation, data: { rootUrl: value.url, status: path.status, length: path.length }, observedAt });
      });
      if (value.paths.length === 0) observations.push({ id: stableSecurityId("observation", execution.id, value.operation, 0), assessmentId: execution.assessmentId, assetId: rootUrl.id, serviceId: null, executionId: execution.id, evidenceId, type: value.operation, data: { paths: [] }, observedAt });
    } else if (execution.operation === "nikto_web_audit" || execution.operation === "wpscan_audit") {
      const value = z.object({ operation: z.enum(["nikto_web_audit", "wpscan_audit"]), url: z.string().url(), findings: z.array(z.object({ id: z.string().nullable(), message: z.string(), url: z.string().nullable() })) }).parse(normalized);
      const url = asset("url", value.url);
      value.findings.forEach((finding, index) => observations.push({ id: stableSecurityId("observation", execution.id, value.operation, index), assessmentId: execution.assessmentId, assetId: url.id, serviceId: null, executionId: execution.id, evidenceId, type: value.operation, data: finding, observedAt }));
      if (value.findings.length === 0) observations.push({ id: stableSecurityId("observation", execution.id, value.operation, 0), assessmentId: execution.assessmentId, assetId: url.id, serviceId: null, executionId: execution.id, evidenceId, type: value.operation, data: { findings: [] }, observedAt });
    } else if (["exiftool_metadata", "hashdeep_file_hash", "binwalk_signature_scan", "tshark_capture_analysis"].includes(execution.operation)) {
      const value = z.object({ operation: z.enum(["exiftool_metadata", "hashdeep_file_hash", "binwalk_signature_scan", "tshark_capture_analysis"]), file: z.string().min(1), metadata: z.record(z.string(), z.unknown()).optional(), sha256: z.string().nullable().optional(), signatures: z.array(z.object({ offset: z.number().int().nonnegative(), description: z.string() })).optional(), packets: z.array(z.object({ number: z.number().int().positive(), timestamp: z.number().nullable(), source: z.string().nullable(), sourcePort: z.number().int().nullable(), destination: z.string().nullable(), destinationPort: z.number().int().nullable(), protocol: z.string().nullable() })).optional() }).parse(normalized);
      const file = asset("file", value.file);
      observations.push({ id: stableSecurityId("observation", execution.id, value.operation, 0), assessmentId: execution.assessmentId, assetId: file.id, serviceId: null, executionId: execution.id, evidenceId, type: value.operation, data: { metadata: value.metadata ?? null, sha256: value.sha256 ?? null, signatures: value.signatures ?? [], packets: value.packets ?? [] }, observedAt });
    } else if (execution.operation === "searchsploit_lookup") {
      const value = z.object({ operation: z.literal("searchsploit_lookup"), query: z.string().min(1), matches: z.array(z.object({ id: z.string().nullable(), title: z.string(), path: z.string().nullable(), type: z.string().nullable(), platform: z.string().nullable() })) }).parse(normalized);
      const software = asset("software", value.query);
      value.matches.forEach((match, index) => observations.push({ id: stableSecurityId("observation", execution.id, value.operation, index), assessmentId: execution.assessmentId, assetId: software.id, serviceId: null, executionId: execution.id, evidenceId, type: "vulnerability_reference", data: match, observedAt }));
      if (value.matches.length === 0) observations.push({ id: stableSecurityId("observation", execution.id, value.operation, 0), assessmentId: execution.assessmentId, assetId: software.id, serviceId: null, executionId: execution.id, evidenceId, type: value.operation, data: { matches: [] }, observedAt });
    } else {
      return;
    }

    this.repository.saveSecurityKnowledge({
      assets: [...assets.values()], services: [...services.values()], observations,
      relationships: [...relationships.values()],
    });
  }

  async executeApprovedOperation(id: string, options: ExecutionOptions = {}) {
    const execution = this.repository.findSecurityExecution(id);
    if (!execution) throw new Error(`Security execution ${id} was not found.`);
    if (execution.status !== "approved") {
      throw new Error(`Security execution ${id} must be approved before dispatch.`);
    }

    const described = this.describeAssessment(execution.assessmentId);
    if (!described || !described.scope) {
      throw new Error(`Security assessment ${execution.assessmentId} is missing its durable scope.`);
    }
    const node = described.executionNode;
    if (!node || node.id !== execution.nodeId) {
      throw new Error(`Security execution ${id} has no matching execution node.`);
    }

    const adapter = getSecurityOperationAdapter(execution.operation);
    if (adapter.classification !== execution.classification) {
      throw new Error(`Security operation ${execution.operation} must be classified as ${adapter.classification}.`);
    }
    const targets = adapter.validate(execution.targets);
    assertSecurityOperationAuthorized({
      assessment: described.assessment,
      scope: described.scope,
      request: { operation: execution.operation, classification: execution.classification, targets },
    });
    if (node.provider !== this.sshProvider.kind || execution.provider !== node.provider) {
      throw new Error(`No ${node.provider} execution provider is configured for execution ${id}.`);
    }
    if (node.status !== "online") {
      throw new Error(`Execution node ${node.id} is not online; refresh it before dispatch.`);
    }
    const capability = node.capabilities.find((value) => value.id === adapter.requiredCapability);
    if (capability?.status !== "available") {
      throw new Error(`Execution node ${node.id} is missing required capability ${adapter.requiredCapability}.`);
    }

    const command = adapter.buildExecution(targets);
    const mcpInvocation = adapter.buildMcpInvocation(targets);
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", forwardAbort, { once: true });
    if (options.signal?.aborted) forwardAbort();
    this.activeExecutions.set(id, controller);
    this.setExecutionStatus(id, "running");
    let rawEvidenceRecorded = false;
    try {
      const result = node.securityRuntime === "kali_mcp"
        ? await this.kaliMcpProvider.call(node, mcpInvocation, controller.signal).then((mcpResult) => {
            const output = mcpResultOutput(mcpResult);
            return {
              requestId: execution.id,
              nodeId: node.id,
              startedAt: mcpResult.startedAt,
              finishedAt: mcpResult.finishedAt,
              exitCode: output.exitCode,
              signal: null,
              timedOut: false,
              cancelled: controller.signal.aborted,
              stdout: output.stdout,
              stderr: output.stderr,
              stdoutTruncated: false,
              stderrTruncated: false,
            };
          })
        : await this.sshProvider.execute(node, createExecutionRequest({
            id: execution.id,
            nodeId: node.id,
            assessmentId: execution.assessmentId,
            taskId: execution.taskId,
            executable: command.executable,
            args: command.args,
            cwd: node.workingDirectory,
            timeoutMs: command.timeoutMs,
          }), { ...options, signal: controller.signal });
      this.recordEvidence({ executionId: id, kind: "stdout", text: result.stdout, truncated: result.stdoutTruncated });
      this.recordEvidence({ executionId: id, kind: "stderr", text: result.stderr, truncated: result.stderrTruncated });
      rawEvidenceRecorded = true;

      if (result.cancelled) {
        const updated = this.setExecutionStatus(id, "cancelled", { exitCode: result.exitCode, cancelled: true });
        return { execution: updated, evidence: this.listEvidence(id), normalized: null };
      }
      const accepted = adapter.acceptsResult?.(result) ?? result.exitCode === 0;
      if (result.timedOut || !accepted) {
        const detail = result.timedOut
          ? `Operation timed out after ${command.timeoutMs}ms.`
          : `Operation exited with code ${result.exitCode ?? "unknown"}.`;
        const updated = this.setExecutionStatus(id, "failed", {
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          error: detail,
        });
        return { execution: updated, evidence: this.listEvidence(id), normalized: null };
      }

      const normalized = adapter.parse(result, targets);
      const normalizedEvidence = this.recordEvidence({
        executionId: id,
        kind: "normalized",
        contentType: "application/json",
        text: JSON.stringify(normalized),
      });
      this.ingestNormalizedResult(execution, normalizedEvidence.id, normalized);
      const updated = this.setExecutionStatus(id, "succeeded", { exitCode: result.exitCode });
      return { execution: updated, evidence: this.listEvidence(id), normalized };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Security operation execution failed.";
      if (!rawEvidenceRecorded) {
        this.recordEvidence({ executionId: id, kind: "stdout", text: "" });
        this.recordEvidence({ executionId: id, kind: "stderr", text: message });
      }
      if (controller.signal.aborted) {
        const updated = this.setExecutionStatus(id, "cancelled", { cancelled: true, error: message });
        return { execution: updated, evidence: this.listEvidence(id), normalized: null };
      }
      this.setExecutionStatus(id, "failed", { error: message });
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", forwardAbort);
      this.activeExecutions.delete(id);
    }
  }

  cancelExecution(id: string): boolean {
    const controller = this.activeExecutions.get(id);
    if (!controller) return false;
    controller.abort(new Error(`Security execution ${id} was cancelled.`));
    return true;
  }

  close(): void {
    void this.kaliMcpProvider.close();
    this.repository.close();
  }
}
