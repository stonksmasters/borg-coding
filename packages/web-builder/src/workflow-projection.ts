import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { WorkflowState } from "../../core/src/contracts.ts";

const projectionPath = ".localcode/build/workflow-state.json";

function ensureProjectionIgnored(root: string) {
  try {
    const raw = execFileSync("git", ["-C", root, "rev-parse", "--git-path", "info/exclude"], { encoding: "utf8" }).trim();
    if (!raw) return;
    const excludePath = isAbsolute(raw) ? raw : resolve(root, raw);
    mkdirSync(dirname(excludePath), { recursive: true });
    const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
    const entries = existing.split(/\r?\n/).map((line) => line.trim());
    if (entries.includes(projectionPath)) return;
    const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
    writeFileSync(excludePath, `${existing}${prefix}${projectionPath}\n`, "utf8");
  } catch {
    // Non-Git project roots may still receive the projection; Git exclusion is best-effort.
  }
}

function untrackGeneratedProjection(root: string) {
  try {
    execFileSync("git", ["-C", root, "ls-files", "--error-unmatch", "--", projectionPath], { stdio: "ignore" });
  } catch {
    return;
  }
  execFileSync("git", ["-C", root, "rm", "--cached", "--ignore-unmatch", "--", projectionPath], { stdio: "ignore" });
}

export function projectWorkflowState(
  rootPath: string,
  state: WorkflowState,
  options: { untrackGeneratedFile?: boolean } = {},
): string {
  const root = resolve(rootPath);
  ensureProjectionIgnored(root);
  if (options.untrackGeneratedFile) untrackGeneratedProjection(root);

  const target = join(root, projectionPath);
  const temporary = `${target}.tmp`;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(temporary, `${JSON.stringify({ generated: true, source: "sqlite", ...state }, null, 2)}\n`, "utf8");
  renameSync(temporary, target);
  return target;
}
