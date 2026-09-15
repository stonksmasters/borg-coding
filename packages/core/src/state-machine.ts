import type { TaskState } from "./contracts.ts";

const transitions: Record<TaskState, readonly TaskState[]> = {
  CREATED: ["CLASSIFYING", "CANCELLED"],
  CLASSIFYING: ["DISCOVERING", "FAILED", "CANCELLED"],
  DISCOVERING: ["PLANNING", "FAILED", "CANCELLED"],
  PLANNING: ["AWAITING_APPROVAL", "IMPLEMENTING", "COMPLETE", "BLOCKED", "FAILED", "CANCELLED"],
  AWAITING_APPROVAL: ["IMPLEMENTING", "CANCELLED"],
  IMPLEMENTING: ["VERIFYING", "BLOCKED", "FAILED", "CANCELLED"],
  VERIFYING: ["IMPLEMENTING", "REVIEWING", "BLOCKED", "FAILED", "CANCELLED"],
  REVIEWING: ["IMPLEMENTING", "COMPLETE", "BLOCKED", "FAILED", "CANCELLED"],
  COMPLETE: [], BLOCKED: [], FAILED: [], CANCELLED: [],
};

export function canTransition(from: TaskState, to: TaskState): boolean { return transitions[from].includes(to); }
export function assertTransition(from: TaskState, to: TaskState): void { if (!canTransition(from, to)) throw new Error(`Invalid task transition: ${from} -> ${to}`); }
