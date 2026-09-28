import { DatabaseSync } from "node:sqlite";
import {
  AssessmentScopeSchema,
  ExecutionNodeSchema,
  SecurityAssessmentSchema,
  type AssessmentScope,
  type ExecutionNode,
  type SecurityAssessment,
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

      CREATE INDEX IF NOT EXISTS idx_security_assessments_project_updated
        ON security_assessments(project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_security_assessments_node
        ON security_assessments(execution_node_id);
      CREATE INDEX IF NOT EXISTS idx_execution_nodes_updated
        ON execution_nodes(updated_at DESC);

      PRAGMA optimize;
    `);
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
    const result = this.database.prepare("DELETE FROM execution_nodes WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  close(): void {
    this.database.close();
  }
}
