import { DatabaseSync } from "node:sqlite";
import { ApprovalSchema, FindingSchema, TaskEventSchema, TaskSchema, type Approval, type Finding, type Task, type TaskEvent } from "../../core/src/contracts.ts";

export class SqliteTaskRepository {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
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
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
        status TEXT NOT NULL, requested_at TEXT NOT NULL, decided_at TEXT,
        worktree_path TEXT, base_commit TEXT, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS findings (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        severity TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_project_updated ON tasks(project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_task_events_task_sequence ON task_events(task_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_findings_task ON findings(task_id);
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

  appendEvent(event: TaskEvent): void {
    this.database.prepare("INSERT INTO task_events (id, task_id, type, payload, occurred_at) VALUES (?, ?, ?, ?, ?)")
      .run(event.id, event.taskId, event.type, JSON.stringify(event.payload), event.occurredAt);
  }

  listEvents(taskId: string): TaskEvent[] {
    const rows = this.database.prepare("SELECT id, task_id, type, payload, occurred_at FROM task_events WHERE task_id = ? ORDER BY sequence").all(taskId) as { id: string; task_id: string; type: string; payload: string; occurred_at: string }[];
    return rows.map((row) => TaskEventSchema.parse({ id: row.id, taskId: row.task_id, type: row.type, payload: JSON.parse(row.payload), occurredAt: row.occurred_at }));
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

  close(): void { this.database.close(); }
}
