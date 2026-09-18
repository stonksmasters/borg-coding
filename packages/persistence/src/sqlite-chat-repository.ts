import { DatabaseSync } from "node:sqlite";
import {
  ChatMessageSchema,
  ChatSessionSchema,
  ModeEscalationRequestSchema,
  type ChatMessage,
  type ChatSession,
  type ModeEscalationRequest,
  type PermissionMode,
} from "../../core/src/chat-session.ts";

export class SqliteChatRepository {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        active_mode TEXT NOT NULL,
        repository_path TEXT,
        workspace_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat_messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        task_id TEXT,
        role TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        metadata TEXT NOT NULL,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat_session_tasks (
        task_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mode_escalation_requests (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated ON chat_sessions(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_chat_messages_session_sequence ON chat_messages(session_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_chat_messages_task ON chat_messages(task_id);
      CREATE INDEX IF NOT EXISTS idx_chat_session_tasks_session ON chat_session_tasks(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mode_escalations_session_created ON mode_escalation_requests(session_id, created_at DESC);
      PRAGMA optimize;
    `);
  }

  saveSession(session: ChatSession): ChatSession {
    const value = ChatSessionSchema.parse(session);
    this.database.prepare(`
      INSERT INTO chat_sessions (
        id, title, active_mode, repository_path, workspace_id, provider, model,
        created_at, updated_at, data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title=excluded.title,
        active_mode=excluded.active_mode,
        repository_path=excluded.repository_path,
        workspace_id=excluded.workspace_id,
        provider=excluded.provider,
        model=excluded.model,
        updated_at=excluded.updated_at,
        data=excluded.data
    `).run(
      value.id,
      value.title,
      value.activeMode,
      value.repositoryPath,
      value.workspaceId,
      value.provider,
      value.model,
      value.createdAt,
      value.updatedAt,
      JSON.stringify(value),
    );
    return value;
  }

  findSession(id: string): ChatSession | null {
    const row = this.database.prepare("SELECT data FROM chat_sessions WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? ChatSessionSchema.parse(JSON.parse(row.data)) : null;
  }

  listSessions(): ChatSession[] {
    const rows = this.database.prepare("SELECT data FROM chat_sessions ORDER BY updated_at DESC").all() as { data: string }[];
    return rows.map((row) => ChatSessionSchema.parse(JSON.parse(row.data)));
  }

  updateSession(id: string, patch: {
    title?: string;
    activeMode?: PermissionMode;
    repositoryPath?: string | null;
    workspaceId?: string;
    provider?: string;
    model?: string;
    parentSessionId?: string | null;
    workflowRole?: ChatSession["workflowRole"];
  }): ChatSession | null {
    const current = this.findSession(id);
    if (!current) return null;
    const updated = ChatSessionSchema.parse({
      ...current,
      ...patch,
      title: patch.title === undefined ? current.title : patch.title.trim() || current.title,
      updatedAt: new Date().toISOString(),
    });
    return this.saveSession(updated);
  }

  touchSession(id: string): void {
    const current = this.findSession(id);
    if (!current) return;
    this.saveSession({ ...current, updatedAt: new Date().toISOString() });
  }

  deleteSession(id: string): boolean {
    const result = this.database.prepare("DELETE FROM chat_sessions WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  appendMessage(message: ChatMessage): ChatMessage {
    const value = ChatMessageSchema.parse(message);
    this.database.prepare(`
      INSERT INTO chat_messages (
        id, session_id, task_id, role, kind, text, metadata, created_at, data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      value.id,
      value.sessionId,
      value.taskId,
      value.role,
      value.kind,
      value.text,
      JSON.stringify(value.metadata),
      value.createdAt,
      JSON.stringify(value),
    );
    this.touchSession(value.sessionId);
    return value;
  }

  listMessages(sessionId: string): ChatMessage[] {
    const rows = this.database.prepare("SELECT data FROM chat_messages WHERE session_id = ? ORDER BY sequence").all(sessionId) as { data: string }[];
    return rows.map((row) => ChatMessageSchema.parse(JSON.parse(row.data)));
  }

  bindTask(sessionId: string, taskId: string): void {
    this.database.prepare(`
      INSERT INTO chat_session_tasks (task_id, session_id, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET session_id=excluded.session_id
    `).run(taskId, sessionId, new Date().toISOString());
    this.touchSession(sessionId);
  }

  sessionForTask(taskId: string): ChatSession | null {
    const row = this.database.prepare("SELECT session_id FROM chat_session_tasks WHERE task_id = ?").get(taskId) as { session_id: string } | undefined;
    return row ? this.findSession(row.session_id) : null;
  }

  latestTaskId(sessionId: string): string | null {
    const row = this.database.prepare("SELECT task_id FROM chat_session_tasks WHERE session_id = ? ORDER BY created_at DESC LIMIT 1").get(sessionId) as { task_id: string } | undefined;
    return row?.task_id ?? null;
  }

  saveModeEscalation(request: ModeEscalationRequest): ModeEscalationRequest {
    const value = ModeEscalationRequestSchema.parse(request);
    this.database.prepare(`
      INSERT INTO mode_escalation_requests (id, session_id, task_id, created_at, data)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        id=excluded.id,
        session_id=excluded.session_id,
        created_at=excluded.created_at,
        data=excluded.data
    `).run(value.id, value.sessionId, value.taskId, value.createdAt, JSON.stringify(value));
    this.touchSession(value.sessionId);
    return value;
  }

  findModeEscalation(taskId: string): ModeEscalationRequest | null {
    const row = this.database.prepare("SELECT data FROM mode_escalation_requests WHERE task_id = ?").get(taskId) as { data: string } | undefined;
    return row ? ModeEscalationRequestSchema.parse(JSON.parse(row.data)) : null;
  }

  latestModeEscalation(sessionId: string): ModeEscalationRequest | null {
    const row = this.database.prepare("SELECT data FROM mode_escalation_requests WHERE session_id = ? ORDER BY created_at DESC LIMIT 1").get(sessionId) as { data: string } | undefined;
    return row ? ModeEscalationRequestSchema.parse(JSON.parse(row.data)) : null;
  }

  deleteModeEscalation(taskId: string): boolean {
    const result = this.database.prepare("DELETE FROM mode_escalation_requests WHERE task_id = ?").run(taskId);
    return Number(result.changes) > 0;
  }

  close(): void {
    this.database.close();
  }
}
