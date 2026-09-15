import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { spawn } from "node:child_process";

function inside(root: string, candidate: string): string {
  const absoluteRoot = resolve(root);
  const absolute = resolve(root, candidate);
  const rel = relative(absoluteRoot, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Path escapes workspace root: ${candidate}`);
  return absolute;
}

function exec(command: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, shell: process.platform === "win32" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => (stdout += data.toString()));
    child.stderr.on("data", (data) => (stderr += data.toString()));
    child.once("error", reject);
    child.once("close", (code) => resolveResult({ code: code ?? -1, stdout, stderr }));
  });
}

export class RepositoryTools {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  read(relativePath: string): Promise<string> {
    return readFile(inside(this.root, relativePath), "utf8");
  }

  async write(relativePath: string, content: string): Promise<void> {
    const target = inside(this.root, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }

  async searchText(query: string): Promise<string> {
    const result = await exec("rg", ["--line-number", "--hidden", "--glob", "!.git", query, "."], this.root);
    if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr || `ripgrep exited ${result.code}`);
    return result.stdout;
  }

  async gitStatus(): Promise<string> {
    const result = await exec("git", ["status", "--short"], this.root);
    if (result.code !== 0) throw new Error(result.stderr);
    return result.stdout;
  }

  async gitDiff(): Promise<string> {
    const result = await exec("git", ["diff", "--no-ext-diff"], this.root);
    if (result.code !== 0) throw new Error(result.stderr);
    return result.stdout;
  }
}
