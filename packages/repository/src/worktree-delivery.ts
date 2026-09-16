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

  async deliver(taskId: string, worktreePath: string, method: "export" | "commit", message?: string) {
    const root = this.validate(taskId, worktreePath);
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
    return { method, commit, worktreePath: root };
  }
}
