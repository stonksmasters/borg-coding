import Database from "better-sqlite3";
import type { AgentEvent, PermissionMode, TaskRecord, TaskStatus } from "@borg/core";

export class TaskStore {
  private readonly db: Database.Database;

  constructor(filename: string) {
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        prompt TEXT NOT NULL,
        workspace_root TEXT,
        permission_mode TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_task_id ON events(task_id, id);
    `);
  }

  createTask(input: { id: string; prompt: string; workspaceRoot?: string; permissionMode: PermissionMode }): TaskRecord {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO tasks (id,prompt,workspace_root,permission_mode,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
      .run(input.id, input.prompt, input.workspaceRoot ?? null, input.permissionMode, "queued", now, now);
    return { id: input.id, prompt: input.prompt, workspaceRoot: input.workspaceRoot ?? null, permissionMode: input.permissionMode, status: "queued", createdAt: now, updatedAt: now };
  }

  setStatus(id: string, status: TaskStatus): void {
    this.db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(status, new Date().toISOString(), id);
  }

  appendEvent(event: AgentEvent): void {
    this.db.prepare("INSERT INTO events (task_id,type,payload_json,created_at) VALUES (?,?,?,?)")
      .run(event.taskId, event.type, JSON.stringify(event), event.at);
  }

  listTasks(limit = 50): TaskRecord[] {
    const rows = this.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?").all(limit) as Array<Record<string, string | null>>;
    return rows.map((row) => ({
      id: row.id!,
      prompt: row.prompt!,
      workspaceRoot: row.workspace_root ?? null,
      permissionMode: row.permission_mode as PermissionMode,
      status: row.status as TaskStatus,
      createdAt: row.created_at!,
      updatedAt: row.updated_at!
    }));
  }
}
