import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  createAssessmentScope,
  createExecutionNode,
  createSecurityAssessment,
  securityAssessmentModes,
  type ExecutionNode,
} from "../../../packages/core/src/security-domain.ts";
import {
  SshExecutionProvider,
  type ExecutionProvider,
} from "../../../packages/core/src/execution-provider.ts";
import { refreshExecutionNode } from "../../../packages/core/src/security-node-service.ts";
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

  close(): void {
    this.repository.close();
  }
}
