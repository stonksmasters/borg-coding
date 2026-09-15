import { z } from "zod";

export const permissionModes = ["ask", "edit", "agent"] as const;
export const PermissionModeSchema = z.enum(permissionModes);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export const taskStatuses = ["queued", "running", "completed", "failed", "cancelled"] as const;
export type TaskStatus = (typeof taskStatuses)[number];

export interface TaskRecord {
  id: string;
  prompt: string;
  workspaceRoot: string | null;
  permissionMode: PermissionMode;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
}

export type AgentEvent =
  | { type: "task.started"; taskId: string; at: string; prompt: string }
  | { type: "model.token"; taskId: string; at: string; text: string }
  | { type: "tool.started"; taskId: string; at: string; tool: string; input: unknown }
  | { type: "tool.completed"; taskId: string; at: string; tool: string; output: unknown; ok: boolean }
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

export const ChatRequestSchema = z.object({
  taskId: z.string().min(1).optional(),
  prompt: z.string().min(1),
  permissionMode: PermissionModeSchema.default("ask"),
  workspaceRoot: z.string().min(1).optional()
});

export type ChatRequest = z.infer<typeof ChatRequestSchema>;
