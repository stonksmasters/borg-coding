import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { WorkflowState } from "../../core/src/contracts.ts";

export function projectWorkflowState(rootPath: string, state: WorkflowState): string {
  const root = resolve(rootPath);
  const target = join(root, ".localcode", "build", "workflow-state.json");
  const temporary = `${target}.tmp`;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(temporary, `${JSON.stringify({ generated: true, source: "sqlite", ...state }, null, 2)}\n`, "utf8");
  renameSync(temporary, target);
  return target;
}
