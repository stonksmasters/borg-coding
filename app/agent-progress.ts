export function stageProgress(stage: string): { title: string; detail: string } | null {
  switch (stage) {
    case "Discovery": return { title: "Getting to know the project", detail: "BORG is checking the current pages and project structure before proposing changes." };
    case "Plan": return { title: "Putting together the implementation plan", detail: "BORG is turning the request and repository evidence into an actionable plan." };
    case "Design Direction": return { title: "Art-directing the website", detail: "BORG is defining hierarchy, typography, composition, page rhythm, content voice, and mobile behavior before implementation." };
    case "Visual Direction": return { title: "Judging visual quality", detail: "The Visual Director is reviewing responsive screenshots against the approved Design Brief and can request another refinement pass." };
    case "Implementation": return { title: "Building the approved design", detail: "BORG is applying the plan in an isolated worktree. The live preview will show the result." };
    case "Verification": return { title: "Checking the website", detail: "BORG is running the available checks on the updated project." };
    case "Review": return { title: "Reviewing the result", detail: "BORG is looking for issues before presenting the finished work." };
    default: return null;
  }
}

export function toolProgress(tool: string, input?: Record<string, unknown>): string {
  const path = typeof input?.path === "string" ? input.path : "";
  const query = typeof input?.query === "string" ? input.query.trim().slice(0, 90) : "";
  if (tool === "repository_read") return path ? `Reading ${path}` : "Reading a repository file";
  if (tool === "repository_list") return path && path !== "." ? `Reviewing files under ${path}` : "Reviewing the project structure";
  if (tool === "repository_search") return query ? `Searching the codebase for “${query}”` : "Searching the codebase";
  if (tool === "repository_file_symbols") return path ? `Mapping symbols in ${path}` : "Mapping file symbols";
  if (["repository_symbols", "repository_definition", "repository_references", "repository_implementations", "repository_call_hierarchy", "repository_change_impact"].includes(tool)) return "Tracing the code paths affected by this work";
  if (["repository_language_status", "repository_diagnostics"].includes(tool)) return "Checking the project's structure and code health";
  if (tool === "web_search") return query ? `Looking up references for “${query}”` : "Looking up current references";
  if (tool === "web_fetch") return "Reading a reference page";
  if (tool === "worktree_patch") return path ? `Updating ${path}` : "Updating the approved worktree";
  if (tool === "worktree_read") return path ? `Checking ${path} in the approved worktree` : "Checking the approved worktree";
  if (tool === "worktree_command") {
    const command = typeof input?.command === "string" ? input.command : "";
    return command ? `Running ${command} in the project` : "Running a project command";
  }
  if (tool === "git_status") return "Checking which files changed";
  if (tool === "git_diff") return path ? `Reviewing the diff for ${path}` : "Reviewing the implementation diff";
  if (tool === "verification_run") return `Running ${String(input?.profile ?? "quick")} verification`;
  if (tool.startsWith("browser_")) return "Verifying the rendered application";
  return "Continuing the current task";
}

export function isUnsupportedLanguageTool(message: string): boolean {
  return message.includes("Language intelligence does not support this file:");
}
