import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

function gitRead(root: string, args: string[]): string | null {
  if (!existsSync(root)) return null;
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true }).trim();
  } catch {
    return null;
  }
}

function changedSourcePaths(status: string) {
  return status.split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .map((value) => value.includes(" -> ") ? value.split(" -> ").at(-1)!.trim() : value)
    .filter((value) => value && !value.startsWith(".localcode/build/"));
}

function safeWorktreeFile(root: string, path: string) {
  const candidate = resolve(root, path);
  const rel = relative(resolve(root), candidate);
  if (rel === ".." || rel.startsWith(".." + sep)) return null;
  try {
    if (!existsSync(candidate) || !statSync(candidate).isFile() || statSync(candidate).size > 256_000) return null;
    return readFileSync(candidate, "utf8");
  } catch {
    return null;
  }
}

export function sourceMutationSnapshot(root: string) {
  const status = gitRead(root, ["status", "--porcelain", "--untracked-files=all"]) ?? "";
  const diff = gitRead(root, ["diff", "--no-ext-diff", "--binary", "--", ".", ":(exclude).localcode/build/**"]) ?? "";
  const paths = changedSourcePaths(status);
  const sourceStatus = status.split(/\r?\n/).filter((line) => line && !line.includes(".localcode/build/"));
  const fileHashes = paths.map((path) => {
    const file = safeWorktreeFile(root, path);
    return [path, file === null ? null : createHash("sha256").update(file).digest("hex")];
  });
  const fingerprint = createHash("sha256").update(JSON.stringify({ status: sourceStatus, diff, fileHashes })).digest("hex");
  return { status, diff, paths, fingerprint };
}

function directRepairDependencies(root: string, paths: string[]) {
  const dependencies = new Set<string>();
  const extensions = ["", ".ts", ".tsx", ".js", ".jsx", ".css", ".scss", ".json"];
  for (const path of paths.slice(0, 20)) {
    const content = safeWorktreeFile(root, path);
    if (!content) continue;
    const imports = [
      ...content.matchAll(/(?:from\s*|import\s*\(|require\s*\(|@import\s*)["'](\.[^"']+)["']/g),
    ].map((match) => match[1]);
    for (const specifier of imports.slice(0, 40)) {
      const absoluteBase = resolve(dirname(resolve(root, path)), specifier);
      const candidates = [
        ...extensions.map((extension) => absoluteBase + extension),
        ...extensions.filter(Boolean).map((extension) => resolve(absoluteBase, "index" + extension)),
      ];
      const match = candidates.find((candidate) => {
        const rel = relative(resolve(root), candidate);
        return rel !== ".."
          && !rel.startsWith(".." + sep)
          && existsSync(candidate)
          && statSync(candidate).isFile()
          && statSync(candidate).size <= 256_000;
      });
      if (!match) continue;
      const rel = relative(resolve(root), match).replaceAll("\\", "/");
      if (!rel.startsWith(".localcode/") && !rel.includes("/node_modules/")) dependencies.add(rel);
    }
  }
  return [...dependencies].filter((path) => !paths.includes(path)).slice(0, 20);
}

export function repairGroundingSnapshot(root: string) {
  const snapshot = sourceMutationSnapshot(root);
  const dependencyPaths = directRepairDependencies(root, snapshot.paths);
  const changedFiles = snapshot.paths.slice(0, 12).map((path) => {
    const content = safeWorktreeFile(root, path);
    return content === null ? `### ${path}\n[unavailable or non-text]` : `### ${path}\n${content.slice(0, 12_000)}`;
  });
  const dependencies = dependencyPaths.slice(0, 12).map((path) => {
    const content = safeWorktreeFile(root, path);
    return content === null ? `### ${path}\n[unavailable or non-text]` : `### ${path}\n${content.slice(0, 8_000)}`;
  });
  return [
    "CURRENT WORKTREE GROUNDING. This snapshot is authoritative for the repair pass; do not rediscover or guess paths.",
    `Changed source files:\n${snapshot.paths.length ? snapshot.paths.map((path) => `- ${path}`).join("\n") : "- none"}`,
    dependencyPaths.length ? `Direct relative dependencies automatically resolved from changed files:\n${dependencyPaths.map((path) => `- ${path}`).join("\n")}` : "",
    `Current source diff:\n${snapshot.diff.slice(0, 40_000) || "[no tracked diff]"}`,
    changedFiles.length ? `Current changed-file contents:\n${changedFiles.join("\n\n")}` : "",
    dependencies.length ? `Current direct-dependency contents:\n${dependencies.join("\n\n")}` : "",
    "Use this bounded neighborhood first. Read beyond it only when a direct dependency proves another file is required for the evidenced repair.",
  ].filter(Boolean).join("\n\n");
}
