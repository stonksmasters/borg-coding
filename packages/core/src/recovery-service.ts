export type RecoveryCategory = "missing_path" | "patch_mismatch" | "port_conflict" | "process_interrupted" | "missing_reference" | "tool_usage" | "no_progress" | "approval_violation" | "path_escape" | "repository_invalid" | "permission_denied" | "retry_exhausted" | "unknown";
export type RecoveryDecision = { disposition: "retry" | "fatal"; category: RecoveryCategory; reason: string; action: string; message: string; attempt: number; maximum: number };
export type PreflightEvidence = { contract: { kind: string }; repairedDirectories: readonly string[]; issues: readonly { severity: string; message: string }[]; gitHead: string | null };

const fatalRules: Array<{ category: RecoveryCategory; pattern: RegExp; action: string }> = [
  { category: "path_escape", pattern: /unsafe worktree path|escapes (?:the approved root|through a (?:parent )?link)|outside borg's managed worktree root|path traversal/i, action: "Stop execution and require operator inspection of the requested path." },
  { category: "approval_violation", pattern: /does not have an approved worktree|requires EDIT or AGENT|not approved|approval.*(?:missing|rejected)|mutation.*not authorized/i, action: "Stop execution and restore the approval boundary before any mutation." },
  { category: "repository_invalid", pattern: /not a valid git worktree|worktree root mismatch|repository.*(?:corrupt|diverged)|bad object|not a git repository/i, action: "Stop execution and recover the repository/worktree from a checkpoint." },
  { category: "permission_denied", pattern: /EACCES|EPERM|permission denied|not writable by BORG|source root is not writable/i, action: "Stop execution because the runtime does not have safe write permission." },
];
const retryRules: Array<{ category: RecoveryCategory; pattern: RegExp; action: string }> = [
  { category: "missing_path", pattern: /ENOENT|no such file or directory|parent is unavailable|parent path.*(?:missing|unavailable)|workspace.*directory.*missing/i, action: "Re-run workspace preflight, recreate contract directories, and continue the same approved slice." },
  { category: "patch_mismatch", pattern: /patch expected .* replacement|old_text may be empty only|new file requires empty old_text|exact text.*(?:not found|mismatch)/i, action: "Re-read only the target file and retry the smallest exact patch without re-planning." },
  { category: "port_conflict", pattern: /EADDRINUSE|address already in use|port .*?(?:occupied|in use)|strictPort/i, action: "Release or replace the managed preview process/port and retry verification." },
  { category: "process_interrupted", pattern: /process .*?(?:crashed|exited|terminated)|connection refused|ECONNRESET|socket hang up|preview.*(?:stopped|crashed)|browser.*closed/i, action: "Restart only the required managed process and continue from the current slice state." },
  { category: "missing_reference", pattern: /cannot find module|could not resolve|module not found|referenced file.*does not exist|failed to resolve import/i, action: "Inspect the referenced source path, repair the missing source/config reference, and retry the same slice." },
  { category: "tool_usage", pattern: /worktree file already exists|unknown worktree tool|tool .* unavailable|cannot invoke|invalid tool/i, action: "Correct the tool choice using the existing slice context and retry without repository rediscovery." },
];

export class RecoveryService {
  classify(input: unknown, attempt: number, maximum: number, options: { noProgress?: boolean } = {}): RecoveryDecision {
    const message = input instanceof Error ? input.message : String(input ?? "Unknown implementation failure");
    const fatal = fatalRules.find((rule) => rule.pattern.test(message));
    if (fatal) return { disposition: "fatal", category: fatal.category, reason: message, action: fatal.action, message, attempt, maximum };
    if (attempt >= maximum) return { disposition: "fatal", category: "retry_exhausted", reason: message, action: "Stop the slice and surface the accumulated evidence after the bounded retry budget is exhausted.", message, attempt, maximum };
    const retry = retryRules.find((rule) => rule.pattern.test(message));
    if (retry) return { disposition: "retry", category: retry.category, reason: message, action: retry.action, message, attempt, maximum };
    if (options.noProgress) return { disposition: "retry", category: "no_progress", reason: message, action: "Preserve the approved plan, re-run workspace preflight, and retry the current slice with the smallest concrete source mutation.", message, attempt, maximum };
    return { disposition: "fatal", category: "unknown", reason: message, action: "Stop rather than repeatedly mutating after an unclassified runtime failure.", message, attempt, maximum };
  }

  compact(decision: RecoveryDecision, preflight: PreflightEvidence, recentFailures: readonly string[] = []): string {
    const repaired = preflight.repairedDirectories.length ? preflight.repairedDirectories.join(", ") : "none";
    const warnings = preflight.issues.filter((issue) => issue.severity === "warning").map((issue) => issue.message).slice(0, 3);
    const failures = recentFailures.map((failure) => failure.trim()).filter(Boolean).slice(-3);
    return [`RECOVERY: ${decision.category}. Continue the SAME approved slice; do not rediscover or re-plan the project.`, `Failure: ${decision.message.slice(0, 1200)}`, `Runtime action: ${decision.action}`, `Workspace preflight: ${preflight.contract.kind}; repaired directories: ${repaired}; Git head: ${preflight.gitHead ?? "unknown"}.`, ...(warnings.length ? [`Preflight warnings: ${warnings.join(" | ")}`] : []), ...(failures.length ? [`Recent tool failures: ${failures.join(" | ")}`] : []), "Use worktree_write for new files, worktree_patch for existing files, and inspect only the target files needed for this recovery."].join("\n");
  }
}
