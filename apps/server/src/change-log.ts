export type FileChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface FileChange {
  path: string;
  previousPath: string | null;
  status: FileChangeStatus;
  additions: number;
  deletions: number;
  patch: string;
}

export interface ChangeLog {
  files: FileChange[];
  additions: number;
  deletions: number;
  diff: string;
  clean: boolean;
}

function statusFromCode(code: string): FileChangeStatus {
  if (code === "??" || code.includes("A")) return "added";
  if (code.includes("R")) return "renamed";
  if (code.includes("D")) return "deleted";
  return "modified";
}

function parseStatus(output: string): FileChange[] {
  const files: FileChange[] = [];
  for (const rawLine of output.split("\n")) {
    if (!rawLine.trim()) continue;
    const code = rawLine.slice(0, 2);
    const value = rawLine.slice(3).trim();
    if (!value) continue;
    const status = statusFromCode(code);
    const rename = status === "renamed" ? value.split(" -> ") : [value];
    const previousPath = status === "renamed" && rename.length > 1 ? rename[0].trim() : null;
    const path = status === "renamed" && rename.length > 1 ? rename.at(-1)!.trim() : value;
    files.push({ path, previousPath, status, additions: 0, deletions: 0, patch: "" });
  }
  return files;
}

function diffSections(diff: string): Map<string, { additions: number; deletions: number; patch: string; previousPath: string | null }> {
  const result = new Map<string, { additions: number; deletions: number; patch: string; previousPath: string | null }>();
  const sections = diff.split(/(?=^diff --git )/m).filter((section) => section.startsWith("diff --git "));
  for (const section of sections) {
    const header = section.match(/^diff --git a\/(.*?) b\/(.*?)$/m);
    if (!header) continue;
    const previousPath = header[1];
    const path = header[2];
    let additions = 0;
    let deletions = 0;
    for (const line of section.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
    }
    result.set(path, { additions, deletions, patch: section.trimEnd(), previousPath: previousPath === path ? null : previousPath });
  }
  return result;
}

export function buildChangeLog(statusOutput: string, diffOutput: string): ChangeLog {
  const statusFiles = parseStatus(statusOutput);
  const sections = diffSections(diffOutput);
  const seen = new Set<string>();
  const files = statusFiles.map((file) => {
    const section = sections.get(file.path) ?? (file.previousPath ? sections.get(file.previousPath) : undefined);
    seen.add(file.path);
    if (file.previousPath) seen.add(file.previousPath);
    return {
      ...file,
      additions: section?.additions ?? 0,
      deletions: section?.deletions ?? 0,
      patch: section?.patch ?? "",
      previousPath: file.previousPath ?? section?.previousPath ?? null,
    };
  });

  for (const [path, section] of sections) {
    if (seen.has(path)) continue;
    files.push({
      path,
      previousPath: section.previousPath,
      status: section.previousPath ? "renamed" : "modified",
      additions: section.additions,
      deletions: section.deletions,
      patch: section.patch,
    });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    files,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    diff: diffOutput.trimEnd(),
    clean: files.length === 0,
  };
}
