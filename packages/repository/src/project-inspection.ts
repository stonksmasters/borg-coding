import { isAbsolute, relative, resolve, sep } from "node:path";
import { readdirSync } from "node:fs";

export interface ProjectEntry {
  path: string;
  type: "file" | "directory";
}

export interface ProjectTreeResult {
  entries: ProjectEntry[];
  truncated: boolean;
  warnings: string[];
}

const DEFAULT_IGNORES = new Set([".git", "node_modules", ".next", "dist", "build", ".wrangler"]);

export function isSensitiveProjectPath(requested: string): boolean {
  const name = requested.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
  return name === ".env" || name.startsWith(".env.") || name === ".npmrc" || name === ".pypirc"
    || /(^|[._-])(secret|credential|token|private[-_]?key)([._-]|$)/i.test(name)
    || /\.(pem|key|p12|pfx)$/i.test(name);
}

export function resolveProjectPath(root: string, requested: string): string {
  if (isSensitiveProjectPath(requested)) throw new Error("Sensitive project files are managed through their dedicated settings.");
  const projectRoot = resolve(root);
  const target = resolve(projectRoot, requested.replaceAll("/", sep));
  const rel = relative(projectRoot, target);
  if (rel.startsWith("..") || isAbsolute(rel) || projectRoot === target) throw new Error("Project path must stay inside the selected workspace.");
  return target;
}

export function inspectProjectTree(
  root: string,
  options: { maxDepth?: number; maxEntries?: number; ignores?: ReadonlySet<string> } = {},
): ProjectTreeResult {
  const projectRoot = resolve(root);
  const maxDepth = Math.max(0, Math.min(20, options.maxDepth ?? 8));
  const maxEntries = Math.max(1, Math.min(10_000, options.maxEntries ?? 2500));
  const ignores = options.ignores ?? DEFAULT_IGNORES;
  const entries: ProjectEntry[] = [];
  const warnings: string[] = [];
  let truncated = false;

  const visit = (directory: string, depth: number) => {
    if (depth > maxDepth || entries.length >= maxEntries) {
      truncated = true;
      return;
    }
    let children;
    try {
      children = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      warnings.push(`Skipped ${relative(projectRoot, directory).split(sep).join("/") || "."}: ${error instanceof Error ? error.message : "unreadable directory"}`);
      return;
    }
    for (const entry of children) {
      if (entries.length >= maxEntries) {
        truncated = true;
        return;
      }
      const absolute = resolve(directory, entry.name);
      const path = relative(projectRoot, absolute).split(sep).join("/");
      if (ignores.has(entry.name) || isSensitiveProjectPath(path) || entry.isSymbolicLink()) continue;
      const type = entry.isDirectory() ? "directory" as const : "file" as const;
      entries.push({ path, type });
      if (type === "directory") visit(absolute, depth + 1);
    }
  };

  visit(projectRoot, 0);
  return { entries, truncated, warnings: warnings.slice(0, 50) };
}
