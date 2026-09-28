import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  createAssessmentScope,
  createExecutionNode,
  createSecurityAssessment,
  createSecurityEvidenceRecord,
  createSecurityExecutionRecord,
  SecurityTargetSchema,
  securityAssessmentModes,
  securityExecutionStatuses,
  securityOperationClasses,
  type ExecutionNode,
  type SecurityAssessment,
  type SecurityExecutionRecord,
} from "../../../packages/core/src/security-domain.ts";
import {
  SshExecutionProvider,
  type ExecutionProvider,
} from "../../../packages/core/src/execution-provider.ts";
import { refreshExecutionNode } from "../../../packages/core/src/security-node-service.ts";
import { assertSecurityOperationAuthorized } from "../../../packages/core/src/security-policy.ts";
import { SqliteSecurityRepository } from "../../../packages/persistence/src/sqlite-security-repository.ts";

const RegisterExecutionNodeInputSchema = z.object({
  id: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).max(200),
  provider: z.enum(["ssh", "local"]).default("ssh"),
  host: z.string().trim().min(1).nullable().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().trim().min(1).nullable().optional(),
  workingDirectory: z.string().trim().min(1).nullable().optional(),
});

const AssessmentScopeInputSchema = z.object({
  allowedDomains: z.array(z.string()).default([]),
  allowedHosts: z.array(z.string()).default([]),
  allowedCidrs: z.array(z.string()).default([]),
  excludedDomains: z.array(z.string()).default([]),
  excludedHosts: z.array(z.string()).default([]),
  excludedCidrs: z.array(z.string()).default([]),
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

export class SecurityService {
  private readonly repository: SqliteSecurityRepository;
  private readonly sshProvider: ExecutionProvider;

  constructor(
    databasePath: string,
    sshProvider: ExecutionProvider = new SshExecutionProvider(),
  ) {
    this.repository = new SqliteSecurityRepository(databasePath);
    this.sshProvider = sshProvider;
  }

  listNodes(): ExecutionNode[] {
    return this.repository.listExecutionNodes();
  }

  registerNode(input: unknown): ExecutionNode {
    const value = RegisterExecutionNodeInputSchema.parse(input);
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
    });
    return this.repository.saveExecutionNode(node);
  }

  async refreshNode(id: string): Promise<ExecutionNode> {
    const node = this.repository.findExecutionNode(id);
    if (!node) throw new Error(`Execution node ${id} was not found.`);
    if (node.provider !== this.sshProvider.kind) {
      throw new Error(`No ${node.provider} execution provider is configured for node ${id}.`);
    }

    const refreshed = await refreshExecutionNode(node, this.sshProvider);
    return this.repository.saveExecutionNode(refreshed);
  }

  listAssessments(projectId: string) {
    return this.repository.listSecurityAssessments(projectId);
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

    const decision = assertSecurityOperationAuthorized({
      assessment: described.assessment,
      scope: described.scope,
      request: {
        operation: value.operation,
        classification: value.classification,
        targets: value.targets,
      },
    });

    const execution = createSecurityExecutionRecord({
      id: value.id ?? randomUUID(),
      assessmentId: described.assessment.id,
      taskId: value.taskId,
      workflowVersion: value.workflowVersion,
      nodeId: described.executionNode.id,
      operationId: value.operationId ?? randomUUID(),
      operation: value.operation,
      classification: value.classification,
      targets: value.targets,
      provider: described.executionNode.provider,
    });
    this.repository.saveSecurityExecution(execution);
    return { execution, decision };
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

  close(): void {
    this.repository.close();
  }
}
