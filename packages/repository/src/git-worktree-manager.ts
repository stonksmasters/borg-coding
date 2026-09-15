import { execFile } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WorktreeInfo { path: string; repositoryPath: string; baseCommit: string; }

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

  describe(info: WorktreeInfo) { return { ...info, name: basename(info.path) }; }
}
