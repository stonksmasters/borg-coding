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

export function repairGroundingSnapshot(root: string, focusPaths: readonly string[] = []) {
  const snapshot = sourceMutationSnapshot(root);
  const normalizedFocus = [...new Set(focusPaths.map((path) => path.replaceAll("\\", "/")).filter(Boolean))];
  const basisPaths = normalizedFocus.length ? normalizedFocus : snapshot.paths;
  const dependencyPaths = directRepairDependencies(root, basisPaths);
  const changedFiles = basisPaths.slice(0, 3).map((path) => {
    const content = safeWorktreeFile(root, path);
    return content === null ? `### ${path}\n[unavailable or non-text]` : `### ${path}\n${content.slice(0, 2_500)}`;
  });
  const dependencies = dependencyPaths.slice(0, 3).map((path) => {
    const content = safeWorktreeFile(root, path);
    return content === null ? `### ${path}\n[unavailable or non-text]` : `### ${path}\n${content.slice(0, 1_500)}`;
  });
  const body = [
    "CURRENT WORKTREE GROUNDING. This snapshot is authoritative for the repair pass; do not rediscover or guess paths.",
    `Repair focus files:\n${basisPaths.length ? basisPaths.slice(0, 12).map((path) => `- ${path}`).join("\n") : "- none"}`,
    dependencyPaths.length ? `Direct relative dependencies automatically resolved from focus files:\n${dependencyPaths.map((path) => `- ${path}`).join("\n")}` : "",
    `Current source diff (bounded):\n${snapshot.diff.slice(0, 4_000) || "[no tracked diff]"}`,
    changedFiles.length ? `Current focus-file contents:\n${changedFiles.join("\n\n")}` : "",
    dependencies.length ? `Current direct-dependency contents:\n${dependencies.join("\n\n")}` : "",
    "Use this bounded neighborhood first. Read beyond it only when a direct dependency proves another file is required for the evidenced repair.",
  ].filter(Boolean).join("\n\n");
  return body.slice(0, 9_000);
}
