import type { TaskEvent } from "./contracts.ts";

export function taskRepositoryPath(events: readonly TaskEvent[]): string | null {
  const binding = events.find((event) => event.type === "TASK_REPOSITORY_BOUND");
  const legacy = events.find((event) => event.type === "WEBSITE_REPOSITORY_SELECTED");
  const value = binding?.payload.repositoryPath ?? legacy?.payload.repositoryPath;
  return typeof value === "string" && value.trim() ? value : null;
}
