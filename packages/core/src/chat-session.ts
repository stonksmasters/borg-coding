import { z } from "zod";

export const permissionModes = ["ask", "plan", "edit", "agent"] as const;
export type PermissionMode = (typeof permissionModes)[number];

export const chatRoles = ["user", "assistant", "system", "tool"] as const;
export const chatMessageKinds = ["prose", "status", "warning", "tool", "evidence", "plan", "diff", "terminal"] as const;

export const ChatSessionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  activeMode: z.enum(permissionModes),
  repositoryPath: z.string().nullable(),
  workspaceId: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  parentSessionId: z.string().min(1).nullable().default(null),
  workflowRole: z.enum(["primary", "frontend_slice", "backend", "styles", "page", "component"]).default("primary"),
});
export type ChatSession = z.infer<typeof ChatSessionSchema>;

export const ChatMessageSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  taskId: z.string().nullable(),
  role: z.enum(chatRoles),
  kind: z.enum(chatMessageKinds),
  text: z.string(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string().datetime(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ModeEscalationRequestSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  taskId: z.string().min(1),
  fromMode: z.literal("plan"),
  requestedMode: z.literal("edit"),
  reason: z.string().min(1),
  planText: z.string(),
  createdAt: z.string().datetime(),
});
export type ModeEscalationRequest = z.infer<typeof ModeEscalationRequestSchema>;

export function createChatSession(input: {
  id: string;
  title?: string;
  activeMode?: PermissionMode;
  repositoryPath?: string | null;
  workspaceId?: string;
  provider?: string;
  model?: string;
  parentSessionId?: string | null;
  workflowRole?: "primary" | "frontend_slice" | "backend" | "styles" | "page" | "component";
}): ChatSession {
  const now = new Date().toISOString();
  return ChatSessionSchema.parse({
    id: input.id,
    title: input.title?.trim() || "New chat",
    createdAt: now,
    updatedAt: now,
    activeMode: input.activeMode ?? "plan",
    repositoryPath: input.repositoryPath ?? null,
    workspaceId: input.workspaceId ?? "borg-code",
    provider: input.provider ?? "ollama",
    model: input.model ?? "qwen3-coder:30b",
    parentSessionId: input.parentSessionId ?? null,
    workflowRole: input.workflowRole ?? "primary",
  });
}

export function createChatMessage(input: {
  id: string;
  sessionId: string;
  taskId?: string | null;
  role: ChatMessage["role"];
  kind?: ChatMessage["kind"];
  text: string;
  metadata?: Record<string, unknown>;
}): ChatMessage {
  return ChatMessageSchema.parse({
    id: input.id,
    sessionId: input.sessionId,
    taskId: input.taskId ?? null,
    role: input.role,
    kind: input.kind ?? "prose",
    text: input.text,
    metadata: input.metadata ?? {},
    createdAt: new Date().toISOString(),
  });
}

export function createModeEscalationRequest(input: {
  id: string;
  sessionId: string;
  taskId: string;
  planText: string;
  reason?: string;
}): ModeEscalationRequest {
  return ModeEscalationRequestSchema.parse({
    id: input.id,
    sessionId: input.sessionId,
    taskId: input.taskId,
    fromMode: "plan",
    requestedMode: "edit",
    reason: input.reason ?? "The approved plan requires mutation-capable tools.",
    planText: input.planText,
    createdAt: new Date().toISOString(),
  });
}
