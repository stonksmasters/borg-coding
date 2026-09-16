import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
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

export interface ReviewHunk {
  id: string;
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  additions: number;
  deletions: number;
  lines: string[];
  patch: string;
}

export interface ReviewFile {
  path: string;
  kind: "modified" | "added" | "deleted";
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: ReviewHunk[];
}

export interface TaskReviewState {
  taskId: string;
  createdAt: string;
  status: string;
  files: ReviewFile[];
  additions: number;
  deletions: number;
  pendingFiles: number;
  pendingHunks: number;
}

interface ReviewFileState {
  existed: boolean;
  content: string | null;
}

interface TaskReviewBaseline {
  taskId: string;
  headSha: string | null;
  createdAt: string;
  files: Record<string, ReviewFileState>;
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

function normalizedLines(content: string): string[] {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized) return [];
  const withoutFinalNewline = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  return withoutFinalNewline ? withoutFinalNewline.split("\n") : [];
}

function joinLines(lines: string[], trailingNewline: boolean): string {
  if (!lines.length) return "";
  return `${lines.join("\n")}${trailingNewline ? "\n" : ""}`;
}

function hunkSideLines(hunk: ReviewHunk, side: "old" | "new"): string[] {
  return hunk.lines
    .filter((line) => !line.startsWith("\\ No newline"))
    .filter((line) => side === "old" ? !line.startsWith("+") : !line.startsWith("-"))
    .map((line) => line.slice(1));
}

function sameLines(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

function applyReviewHunk(source: string, hunk: ReviewHunk, direction: "accept" | "reject", targetTrailingNewline: boolean): string {
  const sourceLines = normalizedLines(source);
  const sourceStart = direction === "accept" ? hunk.oldStart : hunk.newStart;
  const sourceCount = direction === "accept" ? hunk.oldCount : hunk.newCount;
  const expected = hunkSideLines(hunk, direction === "accept" ? "old" : "new");
  const replacement = hunkSideLines(hunk, direction === "accept" ? "new" : "old");
  const startIndex = Math.max(0, sourceStart - 1);
  const actual = sourceLines.slice(startIndex, startIndex + sourceCount);
  if (!sameLines(actual, expected)) throw new Error("Review hunk is stale. Refresh the diff and try again.");
  sourceLines.splice(startIndex, sourceCount, ...replacement);
  return joinLines(sourceLines, targetTrailingNewline);
}

function parseReviewHunks(path: string, diff: string): ReviewHunk[] {
  const lines = diff.split(/\r?\n/);
  const hunks: ReviewHunk[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index] ?? "";
    const match = header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!match) continue;

    const hunkLines: string[] = [];
    let cursor = index + 1;
    while (cursor < lines.length && !(lines[cursor] ?? "").startsWith("@@ ")) {
      const line = lines[cursor] ?? "";
      if (line.startsWith("diff --git ")) break;
      if (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-") || line.startsWith("\\ No newline")) hunkLines.push(line);
      cursor += 1;
    }

    const additions = hunkLines.filter((line) => line.startsWith("+")).length;
    const deletions = hunkLines.filter((line) => line.startsWith("-")).length;
    const id = createHash("sha1").update(`${path}\n${header}\n${hunkLines.join("\n")}`).digest("hex").slice(0, 16);
    hunks.push({
      id,
      header,
      oldStart: Number(match[1]),
      oldCount: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3]),
      newCount: match[4] === undefined ? 1 : Number(match[4]),
      additions,
      deletions,
      lines: hunkLines,
      patch: [header, ...hunkLines].join("\n")
    });
    index = cursor - 1;
  }

  return hunks;
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

  private reviewBaselinePath(taskId: string): string {
    return `.localcode/reviews/${safeTaskId(taskId)}/baseline.json`;
  }

  private async currentStatusPaths(): Promise<string[]> {
    const result = await exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], this.root);
    if (result.code !== 0) throw new Error(result.stderr || "Unable to inspect Git working tree");
    const tokens = result.stdout.split("\0").filter(Boolean);
    const paths = new Set<string>();

    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      const status = token.slice(0, 2);
      const path = token.slice(3);
      if (path && !path.startsWith(".localcode/")) paths.add(path);
      if (status.includes("R") || status.includes("C")) index += 1;
    }
    return [...paths];
  }

  private async currentFileState(path: string): Promise<ReviewFileState> {
    const content = await this.readOptional(path);
    return { existed: content !== null, content };
  }

  private async headSha(): Promise<string | null> {
    const result = await exec("git", ["rev-parse", "--verify", "HEAD"], this.root);
    return result.code === 0 ? result.stdout.trim() || null : null;
  }

  private async headFileState(headSha: string | null, path: string): Promise<ReviewFileState> {
    if (!headSha) return { existed: false, content: null };
    const result = await exec("git", ["show", `${headSha}:${path}`], this.root);
    return result.code === 0 ? { existed: true, content: result.stdout } : { existed: false, content: null };
  }

  private async loadTaskBaseline(taskId: string): Promise<TaskReviewBaseline | null> {
    const raw = await this.readOptional(this.reviewBaselinePath(taskId));
    if (!raw) return null;
    return JSON.parse(raw) as TaskReviewBaseline;
  }

  private async saveTaskBaseline(baseline: TaskReviewBaseline): Promise<void> {
    await this.ensureLocalCodeExcluded();
    await this.write(this.reviewBaselinePath(baseline.taskId), JSON.stringify(baseline));
  }

  async captureTaskBaseline(taskId: string): Promise<TaskReviewBaseline> {
    const existing = await this.loadTaskBaseline(taskId);
    if (existing) return existing;

    await this.ensureLocalCodeExcluded();
    const baseline: TaskReviewBaseline = {
      taskId,
      headSha: await this.headSha(),
      createdAt: new Date().toISOString(),
      files: {}
    };

    try {
      const paths = await this.currentStatusPaths();
      for (const path of paths) baseline.files[path] = await this.currentFileState(path);
    } catch {
      // Non-Git workspaces can still run tasks; granular review simply won't be available.
    }

    await this.saveTaskBaseline(baseline);
    return baseline;
  }

  private async baselineFileState(baseline: TaskReviewBaseline, path: string): Promise<ReviewFileState> {
    return baseline.files[path] ?? this.headFileState(baseline.headSha, path);
  }

  private async diffHunks(path: string, baseline: ReviewFileState, current: ReviewFileState): Promise<ReviewHunk[]> {
    const tempDirectory = `.localcode/review-tmp/${randomUUID()}`;
    const oldPath = `${tempDirectory}/old.txt`;
    const newPath = `${tempDirectory}/new.txt`;
    await this.write(oldPath, baseline.content ?? "");
    await this.write(newPath, current.content ?? "");

    try {
      const result = await exec("git", ["diff", "--no-index", "--no-ext-diff", "--unified=3", "--", inside(this.root, oldPath), inside(this.root, newPath)], this.root);
      if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr || `git diff --no-index exited ${result.code}`);
      return parseReviewHunks(path, result.stdout);
    } finally {
      await rm(inside(this.root, tempDirectory), { recursive: true, force: true });
    }
  }

  async getTaskReview(taskId: string): Promise<TaskReviewState> {
    const baseline = await this.loadTaskBaseline(taskId);
    if (!baseline) throw new Error("No review baseline exists for this task");

    const candidates = new Set(Object.keys(baseline.files));
    for (const path of await this.currentStatusPaths()) candidates.add(path);

    const files: ReviewFile[] = [];
    for (const path of [...candidates].sort()) {
      const [before, current] = await Promise.all([this.baselineFileState(baseline, path), this.currentFileState(path)]);
      if (before.existed === current.existed && before.content === current.content) continue;

      const binary = Boolean(before.content?.includes("\0") || current.content?.includes("\0"));
      const hunks = binary ? [] : await this.diffHunks(path, before, current);
      const kind: ReviewFile["kind"] = !before.existed && current.existed ? "added" : before.existed && !current.existed ? "deleted" : "modified";
      files.push({
        path,
        kind,
        binary,
        additions: hunks.reduce((sum, hunk) => sum + hunk.additions, 0),
        deletions: hunks.reduce((sum, hunk) => sum + hunk.deletions, 0),
        hunks
      });
    }

    return {
      taskId,
      createdAt: baseline.createdAt,
      status: await this.gitStatus(),
      files,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      pendingFiles: files.length,
      pendingHunks: files.reduce((sum, file) => sum + file.hunks.length, 0)
    };
  }

  private async restoreFileState(path: string, state: ReviewFileState): Promise<void> {
    if (state.existed) await this.write(path, state.content ?? "");
    else await this.remove(path);
  }

  async acceptReviewFile(taskId: string, path: string): Promise<TaskReviewState> {
    const baseline = await this.loadTaskBaseline(taskId);
    if (!baseline) throw new Error("No review baseline exists for this task");
    baseline.files[path] = await this.currentFileState(path);
    await this.saveTaskBaseline(baseline);
    return this.getTaskReview(taskId);
  }

  async rejectReviewFile(taskId: string, path: string): Promise<TaskReviewState> {
    const baseline = await this.loadTaskBaseline(taskId);
    if (!baseline) throw new Error("No review baseline exists for this task");
    await this.restoreFileState(path, await this.baselineFileState(baseline, path));
    return this.getTaskReview(taskId);
  }

  private async reviewHunk(taskId: string, path: string, hunkId: string): Promise<{ baseline: TaskReviewBaseline; hunk: ReviewHunk; before: ReviewFileState; current: ReviewFileState }> {
    const baseline = await this.loadTaskBaseline(taskId);
    if (!baseline) throw new Error("No review baseline exists for this task");
    const review = await this.getTaskReview(taskId);
    const file = review.files.find((item) => item.path === path);
    const hunk = file?.hunks.find((item) => item.id === hunkId);
    if (!file || !hunk) throw new Error("Review hunk is stale. Refresh the diff and try again.");
    const [before, current] = await Promise.all([this.baselineFileState(baseline, path), this.currentFileState(path)]);
    return { baseline, hunk, before, current };
  }

  async acceptReviewHunk(taskId: string, path: string, hunkId: string): Promise<TaskReviewState> {
    const { baseline, hunk, before, current } = await this.reviewHunk(taskId, path, hunkId);
    if (hunk.lines.length === 0) throw new Error("Binary changes can only be accepted or rejected at file level");
    const updated = applyReviewHunk(before.content ?? "", hunk, "accept", Boolean(current.content?.endsWith("\n")));
    baseline.files[path] = { existed: current.existed || updated.length > 0, content: current.existed || updated.length > 0 ? updated : null };
    await this.saveTaskBaseline(baseline);
    return this.getTaskReview(taskId);
  }

  async rejectReviewHunk(taskId: string, path: string, hunkId: string): Promise<TaskReviewState> {
    const { hunk, before, current } = await this.reviewHunk(taskId, path, hunkId);
    if (hunk.lines.length === 0) throw new Error("Binary changes can only be accepted or rejected at file level");
    const updated = applyReviewHunk(current.content ?? "", hunk, "reject", Boolean(before.content?.endsWith("\n")));
    await this.restoreFileState(path, { existed: before.existed || updated.length > 0, content: before.existed || updated.length > 0 ? updated : null });
    return this.getTaskReview(taskId);
  }

  async acceptAllReviewChanges(taskId: string): Promise<TaskReviewState> {
    const baseline = await this.loadTaskBaseline(taskId);
    if (!baseline) throw new Error("No review baseline exists for this task");
    const review = await this.getTaskReview(taskId);
    for (const file of review.files) baseline.files[file.path] = await this.currentFileState(file.path);
    await this.saveTaskBaseline(baseline);
    return this.getTaskReview(taskId);
  }

  async rejectAllReviewChanges(taskId: string): Promise<TaskReviewState> {
    const baseline = await this.loadTaskBaseline(taskId);
    if (!baseline) throw new Error("No review baseline exists for this task");
    const review = await this.getTaskReview(taskId);
    for (const file of review.files) await this.restoreFileState(file.path, await this.baselineFileState(baseline, file.path));
    return this.getTaskReview(taskId);
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
