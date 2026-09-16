import type { PermissionMode, ToolName } from "@borg/core";

export type PermissionDecision = "allow" | "approval";

const readOnlyTools = new Set<ToolName>(["read_file", "search_text", "git_status", "git_diff", "symbol_search", "file_symbols", "symbol_definition", "symbol_references", "symbol_implementations", "symbol_info", "code_diagnostics"]);

export function permissionDecision(mode: PermissionMode, tool: ToolName): PermissionDecision {
  if (readOnlyTools.has(tool)) return "allow";
  if (mode === "agent") return "allow";
  if (mode === "edit" && (tool === "write_file" || tool === "verify" || tool === "undo_last_change")) return "allow";
  return "approval";
}
