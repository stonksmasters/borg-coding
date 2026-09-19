import { DatabaseSync } from "node:sqlite";
import {
  ApprovalSchema,
  FindingSchema,
  HandoffSchema,
  RoleAssignmentSchema,
  ReviewDecisionSchema,
  ReviewFindingOccurrenceSchema,
  ReviewFindingRecordSchema,
  ReviewRunSchema,
  TaskCheckpointSchema,
  TaskContinuationSchema,
  TaskEventSchema,
  TaskSchema,
  WorkflowStateSchema,
  type Approval,
  type Finding,
  type Handoff,
  type RoleAssignment,
  type ReviewDecision,
  type ReviewFindingOccurrence,
  type ReviewFindingRecord,
  type ReviewRun,
  type Task,
  type TaskCheckpoint,
  type TaskContinuation,
  type TaskEvent,
  type WorkflowState,
} from "../../core/src/contracts.ts";

export class SqliteTaskRepository {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, request TEXT NOT NULL,
        state TEXT NOT NULL, risk_level TEXT NOT NULL, data TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        type TEXT NOT NULL, payload TEXT NOT NULL, occurred_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_workflows (
        project_id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        phase TEXT NOT NULL, status TEXT NOT NULL, next_action TEXT NOT NULL,
        version INTEGER NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS model_contexts (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        role TEXT NOT NULL, model TEXT NOT NULL, slice_id TEXT,
        input_text TEXT NOT NULL, manifest_json TEXT NOT NULL,
        input_sha256 TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_model_contexts_task_created ON model_contexts(task_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
        status TEXT NOT NULL, requested_at TEXT NOT NULL, decided_at TEXT,
        worktree_path TEXT, base_commit TEXT, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS findings (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        severity TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS role_assignments (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        role TEXT NOT NULL, status TEXT NOT NULL, attempt INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS handoffs (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        from_role TEXT NOT NULL, to_role TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_checkpoints (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        name TEXT NOT NULL, kind TEXT NOT NULL, task_state TEXT NOT NULL,
        mode TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_continuations (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        checkpoint_id TEXT NOT NULL REFERENCES task_checkpoints(id) ON DELETE RESTRICT,
        status TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS review_runs (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        checkpoint_id TEXT REFERENCES task_checkpoints(id) ON DELETE SET NULL,
        continuation_id TEXT REFERENCES task_continuations(id) ON DELETE SET NULL,
        status TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS review_finding_records (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        fingerprint TEXT NOT NULL, state TEXT NOT NULL, last_seen_at TEXT NOT NULL, data TEXT NOT NULL,
        UNIQUE(task_id, fingerprint)
      );
      CREATE TABLE IF NOT EXISTS review_finding_occurrences (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,
        finding_id TEXT NOT NULL REFERENCES review_finding_records(id) ON DELETE CASCADE,
        observed_at TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS review_decisions (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        finding_id TEXT NOT NULL REFERENCES review_finding_records(id) ON DELETE RESTRICT,
        action TEXT NOT NULL, actor_type TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_project_updated ON tasks(project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_task_events_task_sequence ON task_events(task_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_findings_task ON findings(task_id);
      CREATE INDEX IF NOT EXISTS idx_role_assignments_task_sequence ON role_assignments(task_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_handoffs_task_sequence ON handoffs(task_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_task_checkpoints_task_sequence ON task_checkpoints(task_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_task_continuations_task_sequence ON task_continuations(task_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_review_runs_task_sequence ON review_runs(task_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_review_findings_task_state ON review_finding_records(task_id, state);
      CREATE INDEX IF NOT EXISTS idx_review_occurrences_finding_sequence ON review_finding_occurrences(finding_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_review_decisions_finding_sequence ON review_decisions(finding_id, sequence);
      PRAGMA optimize;
    `);
  }

  saveTask(task: Task): void {
    const value = TaskSchema.parse(task);
    this.database.prepare(`
      INSERT INTO tasks (id, project_id, request, state, risk_level, data, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET request=excluded.request, state=excluded.state,
      risk_level=excluded.risk_level, data=excluded.data, updated_at=excluded.updated_at
    `).run(value.id, value.projectId, value.request, value.state, value.riskLevel, JSON.stringify(value), value.createdAt, value.updatedAt);
  }

  findTask(id: string): Task | null {
    const row = this.database.prepare("SELECT data FROM tasks WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? TaskSchema.parse(JSON.parse(row.data)) : null;
  }

  listTasks(projectId: string): Task[] {
    const rows = this.database.prepare("SELECT data FROM tasks WHERE project_id = ? ORDER BY updated_at DESC").all(projectId) as { data: string }[];
    return rows.map((row) => TaskSchema.parse(JSON.parse(row.data)));
  }

  saveWorkflow(state: WorkflowState): void {
    const value = WorkflowStateSchema.parse(state);
    this.database.prepare(`
      INSERT INTO project_workflows (project_id, task_id, phase, status, next_action, version, updated_at, data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET task_id=excluded.task_id, phase=excluded.phase,
      status=excluded.status, next_action=excluded.next_action, version=excluded.version,
      updated_at=excluded.updated_at, data=excluded.data
    `).run(value.projectId, value.taskId, value.phase, value.status, value.nextAction, value.version, value.updatedAt, JSON.stringify(value));
  }

  findWorkflow(projectId: string): WorkflowState | null {
    const row = this.database.prepare("SELECT data FROM project_workflows WHERE project_id = ?").get(projectId) as { data: string } | undefined;
    return row ? WorkflowStateSchema.parse(JSON.parse(row.data)) : null;
  }

  commitWorkflowTransition(task: Task, event: TaskEvent, state: WorkflowState): void {
    const taskValue = TaskSchema.parse(task);
    const eventValue = TaskEventSchema.parse(event);
    const workflowValue = WorkflowStateSchema.parse(state);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.saveTask(taskValue);
      this.appendEvent(eventValue);
      this.saveWorkflow(workflowValue);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  appendEvent(event: TaskEvent): void {
    this.database.prepare("INSERT INTO task_events (id, task_id, type, payload, occurred_at) VALUES (?, ?, ?, ?, ?)")
      .run(event.id, event.taskId, event.type, JSON.stringify(event.payload), event.occurredAt);
  }

  listEvents(taskId: string): TaskEvent[] {
    const rows = this.database.prepare("SELECT id, task_id, type, payload, occurred_at FROM task_events WHERE task_id = ? ORDER BY sequence").all(taskId) as { id: string; task_id: string; type: string; payload: string; occurred_at: string }[];
    return rows.map((row) => TaskEventSchema.parse({ id: row.id, taskId: row.task_id, type: row.type, payload: JSON.parse(row.payload), occurredAt: row.occurred_at }));
  }

  saveModelContext(input: { id: string; taskId: string; role: string; model: string; sliceId: string | null; inputText: string; manifest: unknown[]; inputSha256: string; createdAt: string }): void {
    this.database.prepare("INSERT INTO model_contexts (id, task_id, role, model, slice_id, input_text, manifest_json, input_sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(input.id, input.taskId, input.role, input.model, input.sliceId, input.inputText, JSON.stringify(input.manifest), input.inputSha256, input.createdAt);
  }

  listModelContexts(taskId: string) {
    return this.database.prepare("SELECT id, task_id, role, model, slice_id, manifest_json, input_sha256, created_at FROM model_contexts WHERE task_id = ? ORDER BY created_at DESC").all(taskId)
      .map((row) => { const value = row as Record<string, string | null>; return { id: value.id, taskId: value.task_id, role: value.role, model: value.model, sliceId: value.slice_id, manifest: JSON.parse(value.manifest_json ?? "[]") as unknown[], inputSha256: value.input_sha256, createdAt: value.created_at }; });
  }

  findModelContext(taskId: string, id: string) {
    const row = this.database.prepare("SELECT id, task_id, role, model, slice_id, input_text, manifest_json, input_sha256, created_at FROM model_contexts WHERE task_id = ? AND id = ?").get(taskId, id) as Record<string, string | null> | undefined;
    return row ? { id: row.id, taskId: row.task_id, role: row.role, model: row.model, sliceId: row.slice_id, inputText: row.input_text, manifest: JSON.parse(row.manifest_json ?? "[]") as unknown[], inputSha256: row.input_sha256, createdAt: row.created_at } : null;
  }

  saveApproval(approval: Approval): void {
    const value = ApprovalSchema.parse(approval);
    this.database.prepare(`
      INSERT INTO approvals (id, task_id, status, requested_at, decided_at, worktree_path, base_commit, data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET status=excluded.status, decided_at=excluded.decided_at,
      worktree_path=excluded.worktree_path, base_commit=excluded.base_commit, data=excluded.data
    `).run(value.id, value.taskId, value.status, value.requestedAt, value.decidedAt, value.worktreePath, value.baseCommit, JSON.stringify(value));
  }

  findApproval(taskId: string): Approval | null {
    const row = this.database.prepare("SELECT data FROM approvals WHERE task_id = ?").get(taskId) as { data: string } | undefined;
    return row ? ApprovalSchema.parse(JSON.parse(row.data)) : null;
  }

  replaceFindings(taskId: string, findings: Finding[]): void {
    const values = findings.map((finding) => FindingSchema.parse(finding));
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM findings WHERE task_id = ?").run(taskId);
      const insert = this.database.prepare("INSERT INTO findings (id, task_id, severity, data) VALUES (?, ?, ?, ?)");
      for (const finding of values) insert.run(finding.id, finding.taskId, finding.severity, JSON.stringify(finding));
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listFindings(taskId: string): Finding[] {
    const rows = this.database.prepare("SELECT data FROM findings WHERE task_id = ? ORDER BY rowid").all(taskId) as { data: string }[];
    return rows.map((row) => FindingSchema.parse(JSON.parse(row.data)));
  }


  saveRoleAssignment(assignment: RoleAssignment): void {
    const value = RoleAssignmentSchema.parse(assignment);
    this.database.prepare(`
      INSERT INTO role_assignments (id, task_id, role, status, attempt, data)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, data=excluded.data
    `).run(value.id, value.taskId, value.role, value.status, value.attempt, JSON.stringify(value));
  }

  listRoleAssignments(taskId: string): RoleAssignment[] {
    const rows = this.database.prepare("SELECT data FROM role_assignments WHERE task_id = ? ORDER BY sequence").all(taskId) as { data: string }[];
    return rows.map((row) => RoleAssignmentSchema.parse(JSON.parse(row.data)));
  }

  saveHandoff(handoff: Handoff): void {
    const value = HandoffSchema.parse(handoff);
    this.database.prepare("INSERT INTO handoffs (id, task_id, from_role, to_role, data) VALUES (?, ?, ?, ?, ?)")
      .run(value.id, value.taskId, value.fromRole, value.toRole, JSON.stringify(value));
  }

  listHandoffs(taskId: string): Handoff[] {
    const rows = this.database.prepare("SELECT data FROM handoffs WHERE task_id = ? ORDER BY sequence").all(taskId) as { data: string }[];
    return rows.map((row) => HandoffSchema.parse(JSON.parse(row.data)));
  }


  saveCheckpoint(checkpoint: TaskCheckpoint): void {
    const value = TaskCheckpointSchema.parse(checkpoint);
    this.database.prepare(`
      INSERT INTO task_checkpoints (id, task_id, name, kind, task_state, mode, created_at, data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(value.id, value.taskId, value.name, value.kind, value.taskState, value.mode, value.createdAt, JSON.stringify(value));
  }

  findCheckpoint(id: string): TaskCheckpoint | null {
    const row = this.database.prepare("SELECT data FROM task_checkpoints WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? TaskCheckpointSchema.parse(JSON.parse(row.data)) : null;
  }

  listCheckpoints(taskId: string): TaskCheckpoint[] {
    const rows = this.database.prepare("SELECT data FROM task_checkpoints WHERE task_id = ? ORDER BY sequence").all(taskId) as { data: string }[];
    return rows.map((row) => TaskCheckpointSchema.parse(JSON.parse(row.data)));
  }

  saveContinuation(continuation: TaskContinuation): void {
    const value = TaskContinuationSchema.parse(continuation);
    this.database.prepare(`
      INSERT INTO task_continuations (id, task_id, checkpoint_id, status, started_at, completed_at, data)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, completed_at=excluded.completed_at, data=excluded.data
    `).run(value.id, value.taskId, value.checkpointId, value.status, value.startedAt, value.completedAt, JSON.stringify(value));
  }

  listContinuations(taskId: string): TaskContinuation[] {
    const rows = this.database.prepare("SELECT data FROM task_continuations WHERE task_id = ? ORDER BY sequence").all(taskId) as { data: string }[];
    return rows.map((row) => TaskContinuationSchema.parse(JSON.parse(row.data)));
  }

  saveReviewRun(run: ReviewRun): void {
    const value = ReviewRunSchema.parse(run);
    this.database.prepare(`
      INSERT INTO review_runs (id, task_id, checkpoint_id, continuation_id, status, started_at, completed_at, data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, completed_at=excluded.completed_at, data=excluded.data
    `).run(value.id, value.taskId, value.checkpointId, value.continuationId, value.status, value.startedAt, value.completedAt, JSON.stringify(value));
  }

  listReviewRuns(taskId: string): ReviewRun[] {
    const rows = this.database.prepare("SELECT data FROM review_runs WHERE task_id = ? ORDER BY sequence").all(taskId) as { data: string }[];
    return rows.map((row) => ReviewRunSchema.parse(JSON.parse(row.data)));
  }

  saveReviewHistory(input: { run?: ReviewRun; records: ReviewFindingRecord[]; occurrences?: ReviewFindingOccurrence[]; decisions?: ReviewDecision[] }): void {
    const run = input.run ? ReviewRunSchema.parse(input.run) : null;
    const records = input.records.map((value) => ReviewFindingRecordSchema.parse(value));
    const occurrences = (input.occurrences ?? []).map((value) => ReviewFindingOccurrenceSchema.parse(value));
    const decisions = (input.decisions ?? []).map((value) => ReviewDecisionSchema.parse(value));
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (run) this.database.prepare(`
        INSERT INTO review_runs (id, task_id, checkpoint_id, continuation_id, status, started_at, completed_at, data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status=excluded.status, completed_at=excluded.completed_at, data=excluded.data
      `).run(run.id, run.taskId, run.checkpointId, run.continuationId, run.status, run.startedAt, run.completedAt, JSON.stringify(run));
      const upsertRecord = this.database.prepare(`
        INSERT INTO review_finding_records (id, task_id, fingerprint, state, last_seen_at, data)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id, fingerprint) DO UPDATE SET state=excluded.state, last_seen_at=excluded.last_seen_at, data=excluded.data
      `);
      for (const value of records) upsertRecord.run(value.id, value.taskId, value.fingerprint, value.state, value.lastSeenAt, JSON.stringify(value));
      const insertOccurrence = this.database.prepare("INSERT INTO review_finding_occurrences (id, task_id, run_id, finding_id, observed_at, data) VALUES (?, ?, ?, ?, ?, ?)");
      for (const value of occurrences) insertOccurrence.run(value.id, value.taskId, value.runId, value.findingId, value.observedAt, JSON.stringify(value));
      const insertDecision = this.database.prepare("INSERT INTO review_decisions (id, task_id, finding_id, action, actor_type, created_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const value of decisions) insertDecision.run(value.id, value.taskId, value.findingId, value.action, value.actorType, value.createdAt, JSON.stringify(value));
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  findReviewFinding(id: string): ReviewFindingRecord | null {
    const row = this.database.prepare("SELECT data FROM review_finding_records WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? ReviewFindingRecordSchema.parse(JSON.parse(row.data)) : null;
  }

  listReviewFindings(taskId: string): ReviewFindingRecord[] {
    const rows = this.database.prepare("SELECT data FROM review_finding_records WHERE task_id = ? ORDER BY sequence").all(taskId) as { data: string }[];
    return rows.map((row) => ReviewFindingRecordSchema.parse(JSON.parse(row.data)));
  }

  listReviewOccurrences(taskId: string): ReviewFindingOccurrence[] {
    const rows = this.database.prepare("SELECT data FROM review_finding_occurrences WHERE task_id = ? ORDER BY sequence").all(taskId) as { data: string }[];
    return rows.map((row) => ReviewFindingOccurrenceSchema.parse(JSON.parse(row.data)));
  }

  listReviewDecisions(taskId: string): ReviewDecision[] {
    const rows = this.database.prepare("SELECT data FROM review_decisions WHERE task_id = ? ORDER BY sequence").all(taskId) as { data: string }[];
    return rows.map((row) => ReviewDecisionSchema.parse(JSON.parse(row.data)));
  }

  listInterruptedTasks(): Task[] {
    const states = ["IMPLEMENTING", "VERIFYING", "REVIEWING", "DELIVERING"];
    const placeholders = states.map(() => "?").join(", ");
    const rows = this.database.prepare(`SELECT data FROM tasks WHERE state IN (${placeholders}) ORDER BY updated_at`).all(...states) as { data: string }[];
    return rows.map((row) => TaskSchema.parse(JSON.parse(row.data)));
  }

  close(): void { this.database.close(); }
}
