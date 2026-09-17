import { execFile } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WorktreeInfo { path: string; repositoryPath: string; baseCommit: string; }
export interface WorktreeRecoveryInfo {
  state: "matched" | "dirty" | "diverged" | "missing";
  path: string;
  headCommit: string | null;
  changedFiles: string[];
  detail: string;
}

export class GitWorktreeManager {
  private readonly worktreeRoot: string;

  constructor(worktreeRoot: string) { this.worktreeRoot = resolve(worktreeRoot); }

  async create(repositoryPath: string, taskId: string): Promise<WorktreeInfo> {
    if (!isAbsolute(repositoryPath)) throw new Error("Repository path must be absolute.");
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(taskId)) throw new Error("Task ID is not safe for a worktree path.");
    const repository = realpathSync(repositoryPath);
    const git = ["-c", `safe.directory=${repository}`, "-C", repository];
    const { stdout: rootOutput } = await execFileAsync("git", [...git, "rev-parse", "--show-toplevel"], { windowsHide: true });
    const gitRoot = realpathSync(rootOutput.trim());
    if (gitRoot.toLowerCase() !== repository.toLowerCase()) throw new Error("The approved repository must be the Git repository root.");
    const { stdout: commitOutput } = await execFileAsync("git", [...git, "rev-parse", "HEAD"], { windowsHide: true });
    const baseCommit = commitOutput.trim();
    if (!/^[0-9a-f]{40,64}$/i.test(baseCommit)) throw new Error("Unable to determine a valid base commit.");

    mkdirSync(this.worktreeRoot, { recursive: true });
    const destination = resolve(this.worktreeRoot, taskId);
    const fromRoot = relative(this.worktreeRoot, destination);
    if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) throw new Error("Unsafe worktree destination.");
    if (existsSync(destination)) throw new Error("A worktree already exists for this task.");
    await execFileAsync("git", [...git, "worktree", "add", "--detach", destination, baseCommit], { windowsHide: true });
    return { path: destination, repositoryPath: repository, baseCommit };
  }


  async inspect(worktreePath: string, expectedBaseCommit: string | null): Promise<WorktreeRecoveryInfo> {
    const candidate = resolve(worktreePath);
    const rel = relative(this.worktreeRoot, candidate);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      return { state: "diverged", path: candidate, headCommit: null, changedFiles: [], detail: "Recorded worktree is outside the managed worktree root." };
    }
    if (!existsSync(candidate)) {
      return { state: "missing", path: candidate, headCommit: null, changedFiles: [], detail: "Recorded worktree no longer exists." };
    }
    try {
      const actual = realpathSync(candidate);
      const root = existsSync(this.worktreeRoot) ? realpathSync(this.worktreeRoot) : this.worktreeRoot;
      const actualRel = relative(root, actual);
      if (actualRel.startsWith("..") || isAbsolute(actualRel)) {
        return { state: "diverged", path: actual, headCommit: null, changedFiles: [], detail: "Resolved worktree escapes the managed worktree root." };
      }
      const git = ["-c", `safe.directory=${actual}`, "-C", actual];
      const { stdout: headOutput } = await execFileAsync("git", [...git, "rev-parse", "HEAD"], { windowsHide: true });
      const headCommit = headOutput.trim();
      if (expectedBaseCommit) {
        try {
          await execFileAsync("git", [...git, "merge-base", "--is-ancestor", expectedBaseCommit, headCommit], { windowsHide: true });
        } catch {
          return { state: "diverged", path: actual, headCommit, changedFiles: [], detail: "The recorded base commit is not an ancestor of the current worktree HEAD." };
        }
      }
      const { stdout: statusOutput } = await execFileAsync("git", [...git, "status", "--porcelain", "-z"], { windowsHide: true, maxBuffer: 2_000_000 });
      const changedFiles = statusOutput.split("\0").filter(Boolean).map((entry) => entry.slice(3)).slice(0, 500);
      return {
        state: changedFiles.length ? "dirty" : "matched",
        path: actual,
        headCommit,
        changedFiles,
        detail: changedFiles.length ? "Worktree exists with uncommitted changes that require inspection." : "Worktree and recorded base commit are valid.",
      };
    } catch (error) {
      return { state: "diverged", path: candidate, headCommit: null, changedFiles: [], detail: error instanceof Error ? error.message : "Unable to inspect recorded worktree." };
    }
  }

  describe(info: WorktreeInfo) { return { ...info, name: basename(info.path) }; }
}

