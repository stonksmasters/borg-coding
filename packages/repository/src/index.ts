import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { spawn } from "node:child_process";

export interface CheckpointRecord {
  id: string;
  taskId: string;
  path: string;
  existed: boolean;
  content: string | null;
  createdAt: string;
}

function inside(root: string, candidate: string): string {
  const absoluteRoot = resolve(root);
  const absolute = resolve(root, candidate);
  const rel = relative(absoluteRoot, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Path escapes workspace root: ${candidate}`);
  return absolute;
}

function exec(command: string, args: string[], cwd: string, onOutput?: (stream: "stdout" | "stderr", text: string) => void): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, shell: false, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      onOutput?.("stdout", text);
    });
    child.stderr.on("data", (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      onOutput?.("stderr", text);
    });
    child.once("error", reject);
    child.once("close", (code) => resolveResult({ code: code ?? -1, stdout, stderr }));
  });
}

function safeTaskId(taskId: string): string {
  return taskId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export class RepositoryTools {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async validateRoot(): Promise<void> {
    const info = await stat(this.root);
    if (!info.isDirectory()) throw new Error(`Workspace root is not a directory: ${this.root}`);
  }

  async ensureLocalCodeExcluded(): Promise<void> {
    const gitDirectory = inside(this.root, ".git");
    try {
      const gitInfo = await stat(gitDirectory);
      if (!gitInfo.isDirectory()) return;
    } catch {
      return;
    }

    const excludePath = inside(this.root, ".git/info/exclude");
    let content = "";
    try {
      content = await readFile(excludePath, "utf8");
    } catch {
      await mkdir(dirname(excludePath), { recursive: true });
    }

    if (content.split(/\r?\n/).some((line) => line.trim() === ".localcode/")) return;
    const prefix = content && !content.endsWith("\n") ? "\n" : "";
    await writeFile(excludePath, `${content}${prefix}.localcode/\n`, "utf8");
  }

  read(relativePath: string): Promise<string> {
    return readFile(inside(this.root, relativePath), "utf8");
  }

  async readOptional(relativePath: string): Promise<string | null> {
    try {
      return await this.read(relativePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async write(relativePath: string, content: string): Promise<void> {
    const target = inside(this.root, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }

  async remove(relativePath: string): Promise<void> {
    await rm(inside(this.root, relativePath), { force: true });
  }

  async listFiles(): Promise<string[]> {
    try {
      const result = await exec("git", ["ls-files", "--cached", "--others", "--exclude-standard"], this.root);
      if (result.code === 0) return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith(".localcode/"));
    } catch {
      // Fall through to ripgrep for non-Git workspaces.
    }

    const result = await exec("rg", ["--files", "--hidden", "-g", "!.git", "-g", "!node_modules", "-g", "!.localcode/**"], this.root);
    if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr || `rg --files exited ${result.code}`);
    return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }

  async searchFiles(query: string): Promise<string[]> {
    const result = await exec("rg", ["--files-with-matches", "--hidden", "--glob", "!.git", "--glob", "!node_modules", "--glob", "!.localcode/**", "--max-filesize", "1M", "--", query, "."], this.root);
    if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr || `ripgrep exited ${result.code}`);
    return result.stdout.split(/\r?\n/).map((line) => line.replace(/^\.\//, "").trim()).filter(Boolean);
  }

  async searchText(query: string): Promise<string> {
    const result = await exec("rg", ["--line-number", "--hidden", "--glob", "!.git", "--glob", "!node_modules", "--glob", "!.localcode/**", "--max-filesize", "1M", "--", query, "."], this.root);
    if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr || `ripgrep exited ${result.code}`);
    return result.stdout;
  }

  async gitStatus(): Promise<string> {
    const result = await exec("git", ["status", "--short", "--untracked-files=all"], this.root);
    if (result.code !== 0) throw new Error(result.stderr);
    return result.stdout.split(/\r?\n/).filter((line) => !line.includes(".localcode/")).join("\n").trim();
  }

  async gitDiff(): Promise<string> {
    const result = await exec("git", ["diff", "--no-ext-diff", "--"], this.root);
    if (result.code !== 0) throw new Error(result.stderr);
    const status = await this.gitStatus();
    const untracked = status.split(/\r?\n/).filter((line) => line.startsWith("?? ")).map((line) => line.slice(3));
    const additions: string[] = [];

    for (const path of untracked.slice(0, 20)) {
      const content = await this.readOptional(path);
      if (content === null || content.includes("\0")) continue;
      const clipped = content.length > 30000 ? `${content.slice(0, 30000)}\n…[truncated]` : content;
      additions.push(`\n--- /dev/null\n+++ b/${path}\n@@ new untracked file @@\n${clipped.split(/\r?\n/).map((line) => `+${line}`).join("\n")}`);
    }

    return `${result.stdout}${additions.join("\n")}`.trim();
  }

  async createCheckpoint(taskId: string, relativePath: string): Promise<CheckpointRecord> {
    await this.ensureLocalCodeExcluded();
    const existing = await this.readOptional(relativePath);
    const record: CheckpointRecord = {
      id: `${Date.now()}-${randomUUID()}`,
      taskId,
      path: relativePath,
      existed: existing !== null,
      content: existing,
      createdAt: new Date().toISOString()
    };
    const checkpointPath = `.localcode/checkpoints/${safeTaskId(taskId)}/${record.id}.json`;
    await this.write(checkpointPath, JSON.stringify(record));
    return record;
  }

  async listCheckpoints(taskId: string): Promise<Array<CheckpointRecord & { checkpointPath: string }>> {
    const directory = `.localcode/checkpoints/${safeTaskId(taskId)}`;
    let names: string[];
    try {
      names = await readdir(inside(this.root, directory));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const records: Array<CheckpointRecord & { checkpointPath: string }> = [];
    for (const name of names.filter((value) => value.endsWith(".json"))) {
      const checkpointPath = `${directory}/${name}`;
      try {
        const record = JSON.parse(await this.read(checkpointPath)) as CheckpointRecord;
        records.push({ ...record, checkpointPath });
      } catch {
        // Ignore incomplete checkpoint metadata instead of blocking undo entirely.
      }
    }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async restoreLastCheckpoint(taskId: string): Promise<CheckpointRecord | null> {
    const [record] = await this.listCheckpoints(taskId);
    if (!record) return null;
    if (record.existed) await this.write(record.path, record.content ?? "");
    else await this.remove(record.path);
    await this.remove(record.checkpointPath);
    return record;
  }

  extension(relativePath: string): string {
    return extname(relativePath).toLowerCase();
  }
}
