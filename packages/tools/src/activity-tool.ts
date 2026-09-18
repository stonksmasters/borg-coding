import { randomUUID } from "node:crypto";

export const activityPhases = ["planning", "inspecting", "editing", "testing", "building", "verifying", "reviewing"] as const;
export const activityStatuses = ["started", "progress", "completed", "failed"] as const;

export type AgentActivityPhase = (typeof activityPhases)[number];
export type AgentActivityStatus = (typeof activityStatuses)[number];

export interface AgentActivityUpdate {
  id: string;
  phase: AgentActivityPhase;
  status: AgentActivityStatus;
  title: string;
  detail: string | null;
  files: string[];
  occurredAt: string;
}

export const activityToolDefinition = {
  type: "function",
  function: {
    name: "activity_update",
    description: "Tell the user, in concise plain English, what meaningful block of work you are doing, what you discovered, or what you are verifying. Use this before meaningful work and at important transitions. Do not use it for every trivial read/search/tool call. File paths are expected work context only; runtime Git evidence remains authoritative for actual changes.",
    parameters: {
      type: "object",
      required: ["phase", "status", "title"],
      properties: {
        phase: { type: "string", enum: [...activityPhases] },
        status: { type: "string", enum: [...activityStatuses] },
        title: { type: "string", minLength: 1, maxLength: 180 },
        detail: { type: "string", maxLength: 600 },
        files: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 400 } },
      },
    },
  },
} as const;

function boundedText(value: unknown, maximum: number): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maximum);
}

export function normalizeActivityUpdate(input: Record<string, unknown>, now = new Date()): AgentActivityUpdate {
  const phase = boundedText(input.phase, 32) as AgentActivityPhase;
  const status = boundedText(input.status, 32) as AgentActivityStatus;
  if (!activityPhases.includes(phase)) throw new Error("Invalid activity phase.");
  if (!activityStatuses.includes(status)) throw new Error("Invalid activity status.");

  const title = boundedText(input.title, 180);
  if (!title) throw new Error("Activity title is required.");
  const detail = boundedText(input.detail, 600) || null;
  const files = Array.isArray(input.files)
    ? [...new Set(input.files.map((value) => boundedText(value, 400)).filter(Boolean))].slice(0, 20)
    : [];

  return {
    id: randomUUID(),
    phase,
    status,
    title,
    detail,
    files,
    occurredAt: now.toISOString(),
  };
}
