import { execFile } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function inside(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

export class WorktreeDelivery {
  private readonly worktreeRoot: string;
  private readonly deliveryRoot: string;

  constructor(worktreeRoot: string, deliveryRoot: string) {
    this.worktreeRoot = worktreeRoot;
    this.deliveryRoot = deliveryRoot;
  }

  private validate(taskId: string, worktreePath: string): string {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(taskId)) throw new Error("Task ID is not safe for delivery.");
    const root = realpathSync(resolve(this.worktreeRoot));
    const worktree = realpathSync(worktreePath);
    if (!inside(root, worktree) || basename(worktree) !== taskId) throw new Error("Delivery worktree is outside BORG's managed root.");
    return worktree;
  }

  private async git(root: string, args: string[]): Promise<string> {
    try {
      const result = await execFileAsync("git", ["-c", `safe.directory=${root}`, "-C", root, ...args], { windowsHide: true, timeout: 60_000, maxBuffer: 5_000_000 });
      return String(result.stdout).trim();
    } catch (error) {
      const detail = error as Error & { stderr?: string };
      throw new Error(detail.stderr?.trim() || detail.message || "Git delivery command failed.");
    }
  }

  async reconcilePromotion(taskId: string, worktreePath: string, promote: { repositoryPath: string; expectedBaseCommit: string }) {
    const root = this.validate(taskId, worktreePath);
    const projectRoot = realpathSync(resolve(promote.repositoryPath));
    const projectGit = await this.git(projectRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const worktreeGit = await this.git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (resolve(projectGit).toLowerCase() !== resolve(worktreeGit).toLowerCase()) {
      return { state: "diverged" as const, commit: null, detail: "The delivery worktree no longer belongs to the project repository." };
    }

    const projectStatus = await this.git(projectRoot, ["status", "--porcelain"]);
    if (projectStatus) return { state: "diverged" as const, commit: null, detail: "The project has uncommitted changes, so interrupted delivery cannot be reconciled automatically." };

    const projectHead = await this.git(projectRoot, ["rev-parse", "HEAD"]);
    const worktreeHead = await this.git(root, ["rev-parse", "HEAD"]);
    if (worktreeHead === promote.expectedBaseCommit) {
      return { state: "not_committed" as const, commit: null, detail: "The interrupted delivery never created a worktree commit." };
    }

    let mergeBase = "";
    try { mergeBase = await this.git(root, ["merge-base", promote.expectedBaseCommit, worktreeHead]); }
    catch { return { state: "diverged" as const, commit: null, detail: "The worktree delivery commit is not descended from the approved base." }; }
    if (mergeBase !== promote.expectedBaseCommit) {
      return { state: "diverged" as const, commit: null, detail: "The worktree delivery commit is not descended from the approved base." };
    }

    if (projectHead === worktreeHead) {
      return { state: "promoted" as const, commit: worktreeHead, detail: "The delivery commit had already been promoted before the process stopped." };
    }
    if (projectHead !== promote.expectedBaseCommit) {
      return { state: "diverged" as const, commit: null, detail: "The project HEAD changed after approval, so interrupted delivery cannot be promoted automatically." };
    }

    await this.git(projectRoot, ["merge", "--ff-only", worktreeHead]);
    return { state: "promoted" as const, commit: worktreeHead, detail: "Recovered the committed slice and completed its pending fast-forward promotion." };
  }

  async deliver(taskId: string, worktreePath: string, method: "export" | "commit", message?: string, promote?: { repositoryPath: string; expectedBaseCommit: string }) {
    const root = this.validate(taskId, worktreePath);
    const projectRoot = promote ? realpathSync(resolve(promote.repositoryPath)) : null;
    if (projectRoot) {
      if (method !== "commit") throw new Error("A reviewed slice must be saved to the project before the next slice can start.");
      const projectGit = await this.git(projectRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
      const worktreeGit = await this.git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
      if (resolve(projectGit).toLowerCase() !== resolve(worktreeGit).toLowerCase()) throw new Error("The slice worktree does not belong to this project.");
      const head = await this.git(projectRoot, ["rev-parse", "HEAD"]);
      if (head !== promote!.expectedBaseCommit) throw new Error("The project changed since this slice started. Review the project before saving this version.");
      const status = await this.git(projectRoot, ["status", "--porcelain"]);
      if (status) throw new Error("The project has uncommitted changes. Review them before saving this slice.");
    }
    await this.git(root, ["add", "-A"]);
    const patch = await this.git(root, ["diff", "--cached", "--binary", "--no-ext-diff", "HEAD"]);
    if (!patch) throw new Error("There are no verified changes to deliver.");
    if (method === "export") {
      const destinationRoot = resolve(this.deliveryRoot);
      mkdirSync(destinationRoot, { recursive: true });
      const path = join(destinationRoot, `${taskId}.patch`);
      writeFileSync(path, `${patch}\n`, "utf8");
      return { method, path, bytes: Buffer.byteLength(`${patch}\n`, "utf8"), worktreePath: root };
    }
    const subject = (message?.trim() || `BORG: task ${taskId}`).replace(/[\r\n]+/g, " ").slice(0, 120);
    await this.git(root, ["-c", "user.name=BORG Code", "-c", "user.email=borg@local", "commit", "-m", subject]);
    const commit = await this.git(root, ["rev-parse", "HEAD"]);
    if (projectRoot) await this.git(projectRoot, ["merge", "--ff-only", commit]);
    return { method, commit, worktreePath: root };
  }
}
