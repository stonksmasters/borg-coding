export function stageProgress(stage: string): { title: string; detail: string } | null {
  switch (stage) {
    case "Discovery": return { title: "Getting to know the project", detail: "BORG is checking the current pages and project structure before proposing changes." };
    case "Plan": return { title: "Putting together the design plan", detail: "The proposed layout, style, and sections will appear in the plan when this pass is complete." };
    case "Implementation": return { title: "Building the approved design", detail: "BORG is applying the plan in an isolated worktree. The live preview will show the result." };
    case "Verification": return { title: "Checking the website", detail: "BORG is running the available checks on the updated project." };
    case "Review": return { title: "Reviewing the result", detail: "BORG is looking for issues before presenting the finished work." };
    default: return null;
  }
}

export function toolProgress(tool: string, input?: Record<string, unknown>): string {
  const path = typeof input?.path === "string" ? input.path : "";
  if (tool === "repository_read" && path === "index.html") return "Reviewing the current homepage";
  if (tool === "repository_read" && /(^|\/)main\.[jt]sx?$/.test(path)) return "Reviewing the page content and layout";
  if (tool === "repository_read" && /\.css$/.test(path)) return "Reviewing the site's colors and styles";
  if (tool === "repository_read" && path === "package.json") return "Checking how the website is set up";
  if (["repository_list", "repository_read", "repository_search", "repository_file_symbols"].includes(tool)) return "Reviewing the current website and its files";
  if (["repository_language_status", "repository_diagnostics"].includes(tool)) return "Checking the project's structure and code health";
  if (tool === "web_search") {
    const query = typeof input?.query === "string" ? input.query.trim().slice(0, 90) : "";
    return query ? `Looking up references for “${query}”` : "Looking up visual and content references";
  }
  if (tool === "web_fetch") return "Reading a reference page";
  if (tool.startsWith("worktree_") || tool.startsWith("repository_write")) return "Updating the website in the approved worktree";
  if (tool.startsWith("browser_")) return "Inspecting the rendered website";
  return "Gathering information for the current task";
}

export function isUnsupportedLanguageTool(message: string): boolean {
  return message.includes("Language intelligence does not support this file:");
}
