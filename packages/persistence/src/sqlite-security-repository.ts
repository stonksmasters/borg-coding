import { DatabaseSync } from "node:sqlite";
import {
  AssessmentScopeSchema,
  ExecutionNodeSchema,
  SecurityAssessmentSchema,
  SecurityEvidenceRecordSchema,
  SecurityExecutionRecordSchema,
  SecurityAssetSchema,
  SecurityNetworkServiceSchema,
  SecurityObservationSchema,
  SecurityRelationshipSchema,
  SecurityInvestigationPlanSchema,
  IdentityProfileSchema,
  IdentityIdentifierSchema,
  SecurityJobSchema,
  type AssessmentScope,
  type ExecutionNode,
  type SecurityAssessment,
  type SecurityEvidenceRecord,
  type SecurityExecutionRecord,
  type SecurityAsset,
  type SecurityNetworkService,
  type SecurityObservation,
  type SecurityRelationship,
  type SecurityInvestigationPlan,
  type IdentityProfile,
  type IdentityIdentifier,
  type SecurityJob,
} from "../../core/src/security-domain.ts";
import type { SecurityStore } from "../../core/src/security-store.ts";

export class SqliteSecurityRepository implements SecurityStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS security_assessment_scopes (
        id TEXT PRIMARY KEY,
        authorization_confirmed INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS execution_nodes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        status TEXT NOT NULL,
        host TEXT,
        port INTEGER NOT NULL,
        username TEXT,
        credential_ref TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS security_assessments (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        scope_id TEXT NOT NULL REFERENCES security_assessment_scopes(id) ON DELETE RESTRICT,
        execution_node_id TEXT REFERENCES execution_nodes(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS security_executions (
        id TEXT PRIMARY KEY,
        assessment_id TEXT NOT NULL REFERENCES security_assessments(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL,
        node_id TEXT NOT NULL REFERENCES execution_nodes(id) ON DELETE RESTRICT,
        operation_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        classification TEXT NOT NULL,
        status TEXT NOT NULL,
        workflow_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS security_investigation_plans (
        id TEXT PRIMARY KEY,
        assessment_id TEXT NOT NULL REFERENCES security_assessments(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS security_evidence (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        assessment_id TEXT NOT NULL REFERENCES security_assessments(id) ON DELETE CASCADE,
        execution_id TEXT NOT NULL REFERENCES security_executions(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS security_assets (
        id TEXT PRIMARY KEY,
        assessment_id TEXT NOT NULL REFERENCES security_assessments(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        asset_key TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        data TEXT NOT NULL,
        UNIQUE(assessment_id, kind, asset_key)
      );

      CREATE TABLE IF NOT EXISTS security_network_services (
        id TEXT PRIMARY KEY,
        assessment_id TEXT NOT NULL REFERENCES security_assessments(id) ON DELETE CASCADE,
        asset_id TEXT NOT NULL REFERENCES security_assets(id) ON DELETE CASCADE,
        port INTEGER NOT NULL,
        protocol TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        data TEXT NOT NULL,
        UNIQUE(assessment_id, asset_id, protocol, port)
      );

      CREATE TABLE IF NOT EXISTS security_observations (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        assessment_id TEXT NOT NULL REFERENCES security_assessments(id) ON DELETE CASCADE,
        asset_id TEXT NOT NULL REFERENCES security_assets(id) ON DELETE CASCADE,
        service_id TEXT REFERENCES security_network_services(id) ON DELETE CASCADE,
        execution_id TEXT NOT NULL REFERENCES security_executions(id) ON DELETE CASCADE,
        evidence_id TEXT NOT NULL REFERENCES security_evidence(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS security_relationships (
        id TEXT PRIMARY KEY,
        assessment_id TEXT NOT NULL REFERENCES security_assessments(id) ON DELETE CASCADE,
        source_asset_id TEXT NOT NULL REFERENCES security_assets(id) ON DELETE CASCADE,
        target_asset_id TEXT NOT NULL REFERENCES security_assets(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        data TEXT NOT NULL,
        UNIQUE(assessment_id, source_asset_id, target_asset_id, kind)
      );

      CREATE TABLE IF NOT EXISTS identity_profiles (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        assessment_id TEXT NOT NULL UNIQUE REFERENCES security_assessments(id) ON DELETE CASCADE,
        execution_node_id TEXT NOT NULL REFERENCES execution_nodes(id) ON DELETE RESTRICT,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS identity_identifiers (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES identity_profiles(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        normalized_value TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data TEXT NOT NULL,
        UNIQUE(profile_id, kind, normalized_value)
      );

      CREATE TABLE IF NOT EXISTS security_jobs (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES identity_profiles(id) ON DELETE CASCADE,
        assessment_id TEXT NOT NULL REFERENCES security_assessments(id) ON DELETE CASCADE,
        execution_id TEXT NOT NULL UNIQUE REFERENCES security_executions(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL REFERENCES execution_nodes(id) ON DELETE RESTRICT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_security_assessments_project_updated
        ON security_assessments(project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_security_assessments_node
        ON security_assessments(execution_node_id);
      CREATE INDEX IF NOT EXISTS idx_execution_nodes_updated
        ON execution_nodes(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_security_executions_assessment_updated
        ON security_executions(assessment_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_security_plans_assessment_updated
        ON security_investigation_plans(assessment_id, updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_security_executions_operation
        ON security_executions(assessment_id, operation_id);
      CREATE INDEX IF NOT EXISTS idx_security_evidence_execution_sequence
        ON security_evidence(execution_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_security_assets_assessment_kind
        ON security_assets(assessment_id, kind, asset_key);
      CREATE INDEX IF NOT EXISTS idx_security_services_assessment_asset
        ON security_network_services(assessment_id, asset_id, port);
      CREATE INDEX IF NOT EXISTS idx_security_observations_assessment_asset
        ON security_observations(assessment_id, asset_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_security_relationships_assessment_source
        ON security_relationships(assessment_id, source_asset_id);
      CREATE INDEX IF NOT EXISTS idx_identity_profiles_project_updated
        ON identity_profiles(project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_identity_identifiers_profile_status
        ON identity_identifiers(profile_id, status, kind);
      CREATE INDEX IF NOT EXISTS idx_security_jobs_status_created
        ON security_jobs(status, created_at);

      PRAGMA optimize;
    `);
  }

  saveIdentityProfile(profile: IdentityProfile): IdentityProfile {
    const value = IdentityProfileSchema.parse(profile);
    this.database.prepare(`INSERT INTO identity_profiles
      (id, project_id, assessment_id, execution_node_id, archived_at, created_at, updated_at, data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, execution_node_id=excluded.execution_node_id,
        archived_at=excluded.archived_at, updated_at=excluded.updated_at, data=excluded.data`).run(
      value.id, value.projectId, value.assessmentId, value.executionNodeId, value.archivedAt,
      value.createdAt, value.updatedAt, JSON.stringify(value),
    );
    return value;
  }

  findIdentityProfile(id: string): IdentityProfile | null {
    const row = this.database.prepare("SELECT data FROM identity_profiles WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? IdentityProfileSchema.parse(JSON.parse(row.data)) : null;
  }

  listIdentityProfiles(projectId: string, includeArchived = false): IdentityProfile[] {
    const rows = this.database.prepare(`SELECT data FROM identity_profiles WHERE project_id = ? ${includeArchived ? "" : "AND archived_at IS NULL"} ORDER BY updated_at DESC`).all(projectId) as { data: string }[];
    return rows.map((row) => IdentityProfileSchema.parse(JSON.parse(row.data)));
  }

  saveIdentityIdentifier(identifier: IdentityIdentifier): IdentityIdentifier {
    const value = IdentityIdentifierSchema.parse(identifier);
    this.database.prepare(`INSERT INTO identity_identifiers
      (id, profile_id, kind, normalized_value, status, created_at, updated_at, data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(profile_id, kind, normalized_value) DO UPDATE SET status=excluded.status,
        updated_at=excluded.updated_at, data=excluded.data`).run(
      value.id, value.profileId, value.kind, value.normalizedValue, value.status,
      value.createdAt, value.updatedAt, JSON.stringify(value),
    );
    return value;
  }

  findIdentityIdentifier(id: string): IdentityIdentifier | null {
    const row = this.database.prepare("SELECT data FROM identity_identifiers WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? IdentityIdentifierSchema.parse(JSON.parse(row.data)) : null;
  }

  listIdentityIdentifiers(profileId: string): IdentityIdentifier[] {
    const rows = this.database.prepare("SELECT data FROM identity_identifiers WHERE profile_id = ? ORDER BY kind, normalized_value").all(profileId) as { data: string }[];
    return rows.map((row) => IdentityIdentifierSchema.parse(JSON.parse(row.data)));
  }

  saveSecurityJob(job: SecurityJob): SecurityJob {
    const value = SecurityJobSchema.parse(job);
    this.database.prepare(`INSERT INTO security_jobs
      (id, profile_id, assessment_id, execution_id, node_id, status, created_at, updated_at, data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at, data=excluded.data`).run(
      value.id, value.profileId, value.assessmentId, value.executionId, value.nodeId,
      value.status, value.createdAt, value.updatedAt, JSON.stringify(value),
    );
    return value;
  }

  findSecurityJob(id: string): SecurityJob | null {
    const row = this.database.prepare("SELECT data FROM security_jobs WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? SecurityJobSchema.parse(JSON.parse(row.data)) : null;
  }

  listSecurityJobs(profileId?: string): SecurityJob[] {
    const rows = profileId
      ? this.database.prepare("SELECT data FROM security_jobs WHERE profile_id = ? ORDER BY created_at DESC").all(profileId)
      : this.database.prepare("SELECT data FROM security_jobs ORDER BY created_at DESC").all();
    return (rows as { data: string }[]).map((row) => SecurityJobSchema.parse(JSON.parse(row.data)));
  }

  saveAssessmentScope(scope: AssessmentScope): AssessmentScope {
    const value = AssessmentScopeSchema.parse(scope);
    this.database.prepare(`
      INSERT INTO security_assessment_scopes (
        id, authorization_confirmed, created_at, updated_at, data
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        authorization_confirmed=excluded.authorization_confirmed,
        updated_at=excluded.updated_at,
        data=excluded.data
    `).run(
      value.id,
      value.authorizationConfirmed ? 1 : 0,
      value.createdAt,
      value.updatedAt,
      JSON.stringify(value),
    );
    return value;
  }

  findAssessmentScope(id: string): AssessmentScope | null {
    const row = this.database.prepare(
      "SELECT data FROM security_assessment_scopes WHERE id = ?",
    ).get(id) as { data: string } | undefined;
    return row ? AssessmentScopeSchema.parse(JSON.parse(row.data)) : null;
  }

  saveSecurityAssessment(assessment: SecurityAssessment): SecurityAssessment {
    const value = SecurityAssessmentSchema.parse(assessment);
    this.database.prepare(`
      INSERT INTO security_assessments (
        id, project_id, name, mode, status, scope_id, execution_node_id,
        created_at, updated_at, data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id=excluded.project_id,
        name=excluded.name,
        mode=excluded.mode,
        status=excluded.status,
        scope_id=excluded.scope_id,
        execution_node_id=excluded.execution_node_id,
        updated_at=excluded.updated_at,
        data=excluded.data
    `).run(
      value.id,
      value.projectId,
      value.name,
      value.mode,
      value.status,
      value.scopeId,
      value.executionNodeId,
      value.createdAt,
      value.updatedAt,
      JSON.stringify(value),
    );
    return value;
  }

  saveSecurityAssessmentBundle(input: {
    assessment: SecurityAssessment;
    scope: AssessmentScope;
  }): SecurityAssessment {
    const scope = AssessmentScopeSchema.parse(input.scope);
    const assessment = SecurityAssessmentSchema.parse(input.assessment);
    if (assessment.scopeId !== scope.id) {
      throw new Error("Security assessment scopeId must reference the scope saved in the same bundle.");
    }

    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.saveAssessmentScope(scope);
      this.saveSecurityAssessment(assessment);
      this.database.exec("COMMIT");
      return assessment;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  findSecurityAssessment(id: string): SecurityAssessment | null {
    const row = this.database.prepare(
      "SELECT data FROM security_assessments WHERE id = ?",
    ).get(id) as { data: string } | undefined;
    return row ? SecurityAssessmentSchema.parse(JSON.parse(row.data)) : null;
  }

  listSecurityAssessments(projectId: string): SecurityAssessment[] {
    const rows = this.database.prepare(
      "SELECT data FROM security_assessments WHERE project_id = ? ORDER BY updated_at DESC",
    ).all(projectId) as { data: string }[];
    return rows.map((row) => SecurityAssessmentSchema.parse(JSON.parse(row.data)));
  }

  saveSecurityInvestigationPlan(plan: SecurityInvestigationPlan): SecurityInvestigationPlan {
    const value = SecurityInvestigationPlanSchema.parse(plan);
    if (!this.findSecurityAssessment(value.assessmentId)) throw new Error(`Security assessment ${value.assessmentId} was not found.`);
    this.database.prepare(`
      INSERT INTO security_investigation_plans (id, assessment_id, status, created_at, updated_at, data)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at, data=excluded.data
    `).run(value.id, value.assessmentId, value.status, value.createdAt, value.updatedAt, JSON.stringify(value));
    return value;
  }

  findSecurityInvestigationPlan(id: string): SecurityInvestigationPlan | null {
    const row = this.database.prepare("SELECT data FROM security_investigation_plans WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? SecurityInvestigationPlanSchema.parse(JSON.parse(row.data)) : null;
  }

  listSecurityInvestigationPlans(assessmentId: string): SecurityInvestigationPlan[] {
    const rows = this.database.prepare("SELECT data FROM security_investigation_plans WHERE assessment_id = ? ORDER BY updated_at DESC").all(assessmentId) as { data: string }[];
    return rows.map((row) => SecurityInvestigationPlanSchema.parse(JSON.parse(row.data)));
  }

  saveExecutionNode(node: ExecutionNode): ExecutionNode {
    const value = ExecutionNodeSchema.parse(node);
    this.database.prepare(`
      INSERT INTO execution_nodes (
        id, name, provider, status, host, port, username, credential_ref,
        created_at, updated_at, data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,
        provider=excluded.provider,
        status=excluded.status,
        host=excluded.host,
        port=excluded.port,
        username=excluded.username,
        credential_ref=excluded.credential_ref,
        updated_at=excluded.updated_at,
        data=excluded.data
    `).run(
      value.id,
      value.name,
      value.provider,
      value.status,
      value.host,
      value.port,
      value.username,
      value.credentialRef,
      value.createdAt,
      value.updatedAt,
      JSON.stringify(value),
    );
    return value;
  }

  findExecutionNode(id: string): ExecutionNode | null {
    const row = this.database.prepare(
      "SELECT data FROM execution_nodes WHERE id = ?",
    ).get(id) as { data: string } | undefined;
    return row ? ExecutionNodeSchema.parse(JSON.parse(row.data)) : null;
  }

  listExecutionNodes(): ExecutionNode[] {
    const rows = this.database.prepare(
      "SELECT data FROM execution_nodes ORDER BY updated_at DESC",
    ).all() as { data: string }[];
    return rows.map((row) => ExecutionNodeSchema.parse(JSON.parse(row.data)));
  }

  deleteExecutionNode(id: string): boolean {
    const affectedRows = this.database.prepare(
      "SELECT data FROM security_assessments WHERE execution_node_id = ?",
    ).all(id) as { data: string }[];
    const affected = affectedRows.map((row) => SecurityAssessmentSchema.parse(JSON.parse(row.data)));

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString();
      for (const assessment of affected) {
        this.saveSecurityAssessment({ ...assessment, executionNodeId: null, updatedAt: now });
      }
      const result = this.database.prepare("DELETE FROM execution_nodes WHERE id = ?").run(id);
      this.database.exec("COMMIT");
      return Number(result.changes) > 0;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  saveSecurityExecution(execution: SecurityExecutionRecord): SecurityExecutionRecord {
    const value = SecurityExecutionRecordSchema.parse(execution);
    this.database.prepare(`
      INSERT INTO security_executions (
        id, assessment_id, task_id, node_id, operation_id, operation,
        classification, status, workflow_version, created_at, updated_at, data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status=excluded.status,
        workflow_version=excluded.workflow_version,
        updated_at=excluded.updated_at,
        data=excluded.data
    `).run(
      value.id,
      value.assessmentId,
      value.taskId,
      value.nodeId,
      value.operationId,
      value.operation,
      value.classification,
      value.status,
      value.workflowVersion,
      value.createdAt,
      value.updatedAt,
      JSON.stringify(value),
    );
    return value;
  }

  findSecurityExecution(id: string): SecurityExecutionRecord | null {
    const row = this.database.prepare(
      "SELECT data FROM security_executions WHERE id = ?",
    ).get(id) as { data: string } | undefined;
    return row ? SecurityExecutionRecordSchema.parse(JSON.parse(row.data)) : null;
  }

  listSecurityExecutions(assessmentId: string): SecurityExecutionRecord[] {
    const rows = this.database.prepare(
      "SELECT data FROM security_executions WHERE assessment_id = ? ORDER BY updated_at DESC",
    ).all(assessmentId) as { data: string }[];
    return rows.map((row) => SecurityExecutionRecordSchema.parse(JSON.parse(row.data)));
  }

  deleteSecurityExecution(id: string): boolean {
    const result = this.database.prepare("DELETE FROM security_executions WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  saveSecurityEvidence(evidence: SecurityEvidenceRecord): SecurityEvidenceRecord {
    const value = SecurityEvidenceRecordSchema.parse(evidence);
    const execution = this.findSecurityExecution(value.executionId);
    if (!execution) throw new Error(`Security execution ${value.executionId} was not found.`);
    if (execution.assessmentId !== value.assessmentId || execution.taskId !== value.taskId) {
      throw new Error("Security evidence must reference the same assessment and task as its execution.");
    }
    this.database.prepare(`
      INSERT INTO security_evidence (
        id, assessment_id, execution_id, task_id, kind, sha256, created_at, data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      value.id,
      value.assessmentId,
      value.executionId,
      value.taskId,
      value.kind,
      value.sha256,
      value.createdAt,
      JSON.stringify(value),
    );
    return value;
  }

  listSecurityEvidence(executionId: string): SecurityEvidenceRecord[] {
    const rows = this.database.prepare(
      "SELECT data FROM security_evidence WHERE execution_id = ? ORDER BY sequence",
    ).all(executionId) as { data: string }[];
    return rows.map((row) => SecurityEvidenceRecordSchema.parse(JSON.parse(row.data)));
  }

  saveSecurityKnowledge(input: {
    assets: SecurityAsset[];
    services: SecurityNetworkService[];
    observations: SecurityObservation[];
    relationships: SecurityRelationship[];
  }): void {
    const assets = input.assets.map((value) => SecurityAssetSchema.parse(value));
    const services = input.services.map((value) => SecurityNetworkServiceSchema.parse(value));
    const observations = input.observations.map((value) => SecurityObservationSchema.parse(value));
    const relationships = input.relationships.map((value) => SecurityRelationshipSchema.parse(value));
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const value of assets) {
        this.database.prepare(`INSERT INTO security_assets (id, assessment_id, kind, asset_key, last_seen_at, data)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET last_seen_at=excluded.last_seen_at, data=excluded.data`).run(
          value.id, value.assessmentId, value.kind, value.key, value.lastSeenAt, JSON.stringify(value),
        );
      }
      for (const value of services) {
        this.database.prepare(`INSERT INTO security_network_services (id, assessment_id, asset_id, port, protocol, last_seen_at, data)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET last_seen_at=excluded.last_seen_at, data=excluded.data`).run(
          value.id, value.assessmentId, value.assetId, value.port, value.protocol, value.lastSeenAt, JSON.stringify(value),
        );
      }
      for (const value of observations) {
        this.database.prepare(`INSERT INTO security_observations
          (id, assessment_id, asset_id, service_id, execution_id, evidence_id, type, observed_at, data)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(
          value.id, value.assessmentId, value.assetId, value.serviceId, value.executionId,
          value.evidenceId, value.type, value.observedAt, JSON.stringify(value),
        );
      }
      for (const value of relationships) {
        this.database.prepare(`INSERT INTO security_relationships
          (id, assessment_id, source_asset_id, target_asset_id, kind, last_seen_at, data)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET last_seen_at=excluded.last_seen_at, data=excluded.data`).run(
          value.id, value.assessmentId, value.sourceAssetId, value.targetAssetId,
          value.kind, value.lastSeenAt, JSON.stringify(value),
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listSecurityAssets(assessmentId: string): SecurityAsset[] {
    const rows = this.database.prepare(
      "SELECT data FROM security_assets WHERE assessment_id = ? ORDER BY kind, asset_key",
    ).all(assessmentId) as { data: string }[];
    return rows.map((row) => SecurityAssetSchema.parse(JSON.parse(row.data)));
  }

  findSecurityAsset(id: string): SecurityAsset | null {
    const row = this.database.prepare("SELECT data FROM security_assets WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? SecurityAssetSchema.parse(JSON.parse(row.data)) : null;
  }

  listSecurityServices(assessmentId: string, assetId?: string): SecurityNetworkService[] {
    const rows = assetId
      ? this.database.prepare("SELECT data FROM security_network_services WHERE assessment_id = ? AND asset_id = ? ORDER BY port").all(assessmentId, assetId)
      : this.database.prepare("SELECT data FROM security_network_services WHERE assessment_id = ? ORDER BY asset_id, port").all(assessmentId);
    return (rows as { data: string }[]).map((row) => SecurityNetworkServiceSchema.parse(JSON.parse(row.data)));
  }

  listSecurityObservations(assessmentId: string, assetId?: string): SecurityObservation[] {
    const rows = assetId
      ? this.database.prepare("SELECT data FROM security_observations WHERE assessment_id = ? AND asset_id = ? ORDER BY sequence").all(assessmentId, assetId)
      : this.database.prepare("SELECT data FROM security_observations WHERE assessment_id = ? ORDER BY sequence").all(assessmentId);
    return (rows as { data: string }[]).map((row) => SecurityObservationSchema.parse(JSON.parse(row.data)));
  }

  listSecurityRelationships(assessmentId: string, assetId?: string): SecurityRelationship[] {
    const rows = assetId
      ? this.database.prepare("SELECT data FROM security_relationships WHERE assessment_id = ? AND (source_asset_id = ? OR target_asset_id = ?) ORDER BY kind").all(assessmentId, assetId, assetId)
      : this.database.prepare("SELECT data FROM security_relationships WHERE assessment_id = ? ORDER BY kind, source_asset_id").all(assessmentId);
    return (rows as { data: string }[]).map((row) => SecurityRelationshipSchema.parse(JSON.parse(row.data)));
  }

  close(): void {
    this.database.close();
  }
}
