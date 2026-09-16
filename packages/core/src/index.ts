import { z } from "zod";

export const permissionModes = ["ask", "edit", "agent"] as const;
export const PermissionModeSchema = z.enum(permissionModes);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export const taskStatuses = ["queued", "running", "completed", "failed", "cancelled"] as const;
export type TaskStatus = (typeof taskStatuses)[number];

export const toolNames = ["read_file", "write_file", "search_text", "git_status", "git_diff", "run_command", "verify", "undo_last_change", "symbol_search", "file_symbols", "symbol_definition", "symbol_references", "symbol_implementations", "symbol_info", "code_diagnostics"] as const;
export const ToolNameSchema = z.enum(toolNames);
export type ToolName = z.infer<typeof ToolNameSchema>;

export interface TaskRecord {
  id: string;
  prompt: string;
  workspaceRoot: string | null;
  permissionMode: PermissionMode;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceIndexSummary {
  root: string;
  generatedAt: string;
  fileCount: number;
  instructionFiles: string[];
  docFiles: string[];
  metadataFiles: string[];
  languages: Record<string, number>;
}

export interface WorkspaceSymbolSummary {
  name: string;
  kind: string;
  path: string;
  line: number;
  column: number;
  container?: string;
}

export interface ApprovalRequest {
  approvalId: string;
  taskId: string;
  tool: ToolName;
  input: Record<string, unknown>;
  reason?: string;
}

export type AgentEvent =
  | { type: "task.started"; taskId: string; at: string; prompt: string }
  | { type: "agent.status"; taskId: string; at: string; message: string }
  | { type: "workspace.indexed"; taskId: string; at: string; summary: WorkspaceIndexSummary; selectedFiles: string[]; selectedSymbols: WorkspaceSymbolSummary[] }
  | { type: "model.token"; taskId: string; at: string; text: string }
  | { type: "tool.started"; taskId: string; at: string; tool: ToolName; input: Record<string, unknown> }
  | { type: "tool.output"; taskId: string; at: string; tool: ToolName; stream: "stdout" | "stderr" | "info"; text: string }
  | { type: "tool.completed"; taskId: string; at: string; tool: ToolName; output: unknown; ok: boolean }
  | { type: "diff.updated"; taskId: string; at: string; status: string; diff: string }
  | { type: "approval.required"; taskId: string; at: string; approvalId: string; tool: ToolName; input: Record<string, unknown>; reason?: string }
  | { type: "approval.resolved"; taskId: string; at: string; approvalId: string; approved: boolean }
  | { type: "verification.completed"; taskId: string; at: string; ok: boolean; output: string }
  | { type: "task.completed"; taskId: string; at: string; text: string }
  | { type: "task.failed"; taskId: string; at: string; error: string };

export interface ModelRequest {
  system?: string;
  prompt: string;
}

export interface ModelAdapter {
  readonly id: string;
  readonly model: string;
  available(): Promise<boolean>;
  generate(request: ModelRequest, onToken?: (token: string) => void): Promise<string>;
}

export interface RuntimeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CodingRuntime {
  readonly id: string;
  available(): Promise<boolean>;
  run(prompt: string, cwd: string, onOutput?: (chunk: string) => void): Promise<RuntimeResult>;
}

export const ToolTurnSchema = z.object({
  type: z.literal("tool"),
  tool: ToolNameSchema,
  input: z.record(z.string(), z.unknown()).default({}),
  reason: z.string().optional()
});

export const FinalTurnSchema = z.object({
  type: z.literal("final"),
  text: z.string()
});

export const AgentTurnSchema = z.discriminatedUnion("type", [ToolTurnSchema, FinalTurnSchema]);
export type AgentTurn = z.infer<typeof AgentTurnSchema>;
export type ToolTurn = z.infer<typeof ToolTurnSchema>;

export const ChatRequestSchema = z.object({
  taskId: z.string().min(1).optional(),
  prompt: z.string().min(1),
  permissionMode: PermissionModeSchema.default("ask"),
  workspaceRoot: z.string().min(1).optional()
});

export type ChatRequest = z.infer<typeof ChatRequestSchema>;
