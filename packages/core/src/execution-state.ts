export const executionStates = ["IMPLEMENT", "VERIFY", "REPAIR", "BROWSER_VERIFY", "REVIEW", "COMPLETE", "BLOCKED"] as const;
export type ExecutionState = (typeof executionStates)[number];

const executionTransitions: Record<ExecutionState, readonly ExecutionState[]> = {
  IMPLEMENT: ["VERIFY", "BLOCKED"],
  VERIFY: ["REPAIR", "BROWSER_VERIFY", "REVIEW", "BLOCKED"],
  REPAIR: ["VERIFY", "BLOCKED"],
  BROWSER_VERIFY: ["REPAIR", "REVIEW", "BLOCKED"],
  REVIEW: ["REPAIR", "COMPLETE", "BLOCKED"],
  COMPLETE: [],
  BLOCKED: [],
};

export function canTransitionExecution(from: ExecutionState, to: ExecutionState): boolean {
  return executionTransitions[from].includes(to);
}

export function assertExecutionTransition(from: ExecutionState, to: ExecutionState): void {
  if (!canTransitionExecution(from, to)) throw new Error(`Invalid execution transition: ${from} -> ${to}`);
}

export type RepairClassification = "syntax" | "type" | "test" | "runtime" | "interaction" | "visual" | "tooling";
export interface VerificationError { file?: string; line?: number; column?: number; code?: string; message: string; }
export interface RepairContext {
  sliceId: string;
  attempt: number;
  classification: RepairClassification;
  verification: { command: string; exitCode: number; errors: VerificationError[] };
  implicatedFiles: string[];
  allowedFiles: string[];
  recentChanges: string[];
  previousRepair?: { filesChanged: string[]; result: "verification_failed" | "tool_failure" };
}

type CommandEvidence = { label?: string; command?: string; args?: string[]; exitCode?: number; stdout?: string; stderr?: string };

function normalizePath(path: string): string { return path.replaceAll("\\", "/").replace(/^\.\//, ""); }

export function parseVerificationErrors(results: readonly CommandEvidence[]): VerificationError[] {
  const errors: VerificationError[] = [];
  for (const result of results.filter((item) => Number(item.exitCode ?? 0) !== 0)) {
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const patterns = [
      /(?:^|\n)([^\n():]+\.(?:tsx?|jsx?|vue|svelte|py|rs|go|cs))\((\d+),(\d+)\):\s*(?:error\s*)?(TS\d+)?[:\s]*(.+)/g,
      /(?:^|\n)([^\n:]+\.(?:tsx?|jsx?|vue|svelte|py|rs|go|cs)):(\d+):(\d+)[:\s]+(?:error\s*)?([^\n]+)/g,
    ];
    for (const pattern of patterns) {
      for (const match of output.matchAll(pattern)) {
        errors.push({ file: normalizePath(match[1].trim()), line: Number(match[2]), column: Number(match[3]), code: match[4]?.startsWith("TS") ? match[4] : undefined, message: (match[5] ?? match[4] ?? "Verification failed").trim().slice(0, 1000) });
      }
      if (errors.length) break;
    }
    if (!errors.length) errors.push({ message: output.trim().slice(0, 2000) || `${result.label ?? result.command ?? "Verification"} failed.` });
  }
  return errors.slice(0, 20);
}

export function buildRepairContext(input: { sliceId?: string; attempt: number; results?: readonly CommandEvidence[]; recentChanges?: readonly string[]; directDependencies?: readonly string[]; previousRepair?: RepairContext["previousRepair"] }): RepairContext {
  const results = input.results ?? [];
  const failed = results.find((item) => Number(item.exitCode ?? 0) !== 0) ?? {};
  const errors = parseVerificationErrors(results);
  const implicatedFiles = [...new Set(errors.flatMap((error) => error.file ? [error.file] : []))];
  const allowedFiles = [...new Set([...implicatedFiles, ...(input.directDependencies ?? []).map(normalizePath)])].slice(0, 12);
  const command = failed.label ?? ([failed.command, ...(failed.args ?? [])].filter(Boolean).join(" ") || "deterministic verification");
  const joined = errors.map((error) => `${error.code ?? ""} ${error.message}`).join(" ");
  const classification: RepairClassification = /TS\d+|type|assignable|compiler/i.test(joined) ? "type" : /test|assert|expect/i.test(`${command} ${joined}`) ? "test" : "runtime";
  return { sliceId: input.sliceId ?? "current-slice", attempt: input.attempt, classification, verification: { command, exitCode: Number(failed.exitCode ?? 1), errors }, implicatedFiles, allowedFiles, recentChanges: [...new Set(input.recentChanges ?? [])].slice(0, 30), previousRepair: input.previousRepair };
}

export function formatRepairContext(context: RepairContext): string {
  const errors = context.verification.errors.map((error) => `${error.file ? `${error.file}${error.line ? `:${error.line}${error.column ? `:${error.column}` : ""}` : ""}\n` : ""}${error.code ? `${error.code}: ` : ""}${error.message}`).join("\n\n");
  return [`REPAIR ${context.attempt + 1}`, `Category: ${context.classification}`, `Failure: ${context.verification.command} (exit ${context.verification.exitCode})`, errors, `Relevant files:\n${context.allowedFiles.length ? context.allowedFiles.map((file) => `- ${file}`).join("\n") : "- No file path was reported; inspect only the failing command evidence."}`, context.recentChanges.length ? `Recent changes:\n${context.recentChanges.map((file) => `- ${file}`).join("\n")}` : "", "Repair only this failure. Do not restart implementation or perform repository-wide discovery."].filter(Boolean).join("\n\n");
}

const repairTools = new Set(["activity_update", "worktree_list", "worktree_read", "worktree_write", "worktree_patch", "worktree_command", "git_diff", "git_status", "repository_diagnostics", "repository_file_graph", "repository_definition", "repository_references", "repository_symbol_info", "browser_open", "browser_click", "browser_dom", "browser_console", "browser_network", "browser_responsive", "browser_screenshot", "browser_accessibility", "browser_close", "browser_server_start"]);
export function executionAllowsTool(state: ExecutionState | undefined, tool: string): boolean {
  if (!state || state === "IMPLEMENT") return true;
  if (state === "REPAIR") return repairTools.has(tool);
  if (state === "VERIFY" || state === "BROWSER_VERIFY") return tool === "activity_update" || tool === "verification_run" || tool === "verification_profiles" || tool.startsWith("browser_") || tool === "worktree_read" || tool === "git_diff" || tool === "git_status";
  return tool === "activity_update" || tool === "worktree_read" || tool === "git_diff" || tool === "git_status";
}
