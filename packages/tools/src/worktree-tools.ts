import { execFile } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { BrowserVerification } from "../../browser-verification/src/index.ts";
import { VisualRegressionService } from "../../visual-regression/src/index.ts";

export interface RecordedApproval {
  taskId: string;
  status: "REQUESTED" | "APPROVED" | "REJECTED";
  worktreePath: string | null;
  baseCommit: string | null;
}

export interface TaskToolContext { taskId: string; }
export interface WorktreeToolOptions {
  worktreeRoot: string;
  findApproval(taskId: string): RecordedApproval | null;
  browser?: BrowserVerification;
  visualRegression?: VisualRegressionService;
}

interface CommandResult {
  command: string;
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

interface VerificationCommand { command: string; args: string[]; label: string; }

const MAX_FILE_BYTES = 500_000;
const MAX_OUTPUT_BYTES = 120_000;
const MAX_COMMAND_SECONDS = 900;
const allowedCommands = new Set(["node", "npm", "python", "python3", "dotnet", "cargo", "go"]);

export const worktreeToolDefinitions = {
  worktree_read: {
    type: "function",
    function: {
      name: "worktree_read",
      description: "Read a text file from the approved task's isolated Git worktree.",
      parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
    },
  },
  worktree_patch: {
    type: "function",
    function: {
      name: "worktree_patch",
      description: "Apply an exact text replacement inside the approved task worktree. To create a new file, use an empty old_text and a path that does not exist.",
      parameters: {
        type: "object", required: ["path", "old_text", "new_text"],
        properties: {
          path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" },
          expected_replacements: { type: "integer", minimum: 1, maximum: 100 },
        },
      },
    },
  },
  worktree_command: {
    type: "function",
    function: {
      name: "worktree_command",
      description: "Run a bounded allowlisted command inside the approved task worktree without a shell.",
      parameters: {
        type: "object", required: ["command"],
        properties: {
          command: { type: "string", enum: [...allowedCommands] },
          args: { type: "array", maxItems: 40, items: { type: "string" } },
          cwd: { type: "string" }, timeout_seconds: { type: "integer", minimum: 1, maximum: MAX_COMMAND_SECONDS },
        },
      },
    },
  },
  git_status: {
    type: "function",
    function: { name: "git_status", description: "Show concise Git status for the approved task worktree.", parameters: { type: "object", properties: {} } },
  },
  git_diff: {
    type: "function",
    function: { name: "git_diff", description: "Show the bounded Git diff for the approved task worktree.", parameters: { type: "object", properties: { path: { type: "string" } } } },
  },
  verification_profiles: {
    type: "function",
    function: { name: "verification_profiles", description: "List deterministic verification profiles detected for the approved task worktree.", parameters: { type: "object", properties: {} } },
  },
  verification_run: {
    type: "function",
    function: {
      name: "verification_run",
      description: "Run a deterministic bounded verification profile in the approved task worktree.",
      parameters: { type: "object", properties: { profile: { type: "string", enum: ["quick", "full"] } } },
    },
  },
} as const;

function isInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

function safeRelativePath(value: unknown): string {
  const path = String(value ?? "").trim().replaceAll("\\", "/");
  if (!path || path.includes("\0") || isAbsolute(path)) throw new Error("A non-empty worktree-relative path is required.");
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..") || segments[0].toLowerCase() === ".git") throw new Error("Unsafe worktree path.");
  return segments.join(sep);
}

function bounded(value: string, maximum = MAX_OUTPUT_BYTES): string {
  return value.length > maximum ? `${value.slice(0, maximum)}\n… output truncated by BORG …` : value;
}

function npmInvocation(args: string[]): { executable: string; args: string[] } {
  const candidates = [
    process.env.npm_execpath,
    resolve(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    resolve(dirname(dirname(process.execPath)), "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const npmCli = candidates.find((candidate) => existsSync(candidate));
  if (!npmCli) throw new Error("The npm CLI could not be located for the current Node.js installation.");
  return { executable: process.execPath, args: [npmCli, ...args] };
}

async function runBounded(command: string, args: string[], cwd: string, timeoutSeconds: number): Promise<CommandResult> {
  if (!allowedCommands.has(command)) throw new Error(`Command is not allowlisted: ${command}`);
  if (args.length > 40 || args.some((argument) => argument.length > 1_000 || argument.includes("\0"))) throw new Error("Command arguments exceed the bounded command policy.");
  const invocation = command === "npm" ? npmInvocation(args) : { executable: command === "node" ? process.execPath : command, args };
  const startedAt = Date.now();
  return await new Promise((resolveResult, reject) => {
    execFile(invocation.executable, invocation.args, {
      cwd, timeout: Math.max(1, Math.min(MAX_COMMAND_SECONDS, timeoutSeconds)) * 1_000,
      maxBuffer: MAX_OUTPUT_BYTES * 2, windowsHide: true,
      env: { ...process.env, CI: "1", NO_COLOR: "1" },
    }, (error, stdout, stderr) => {
      if (error && typeof (error as NodeJS.ErrnoException).code === "string" && (error as NodeJS.ErrnoException).code === "ENOENT") return reject(new Error(`Command was not found: ${command}`));
      const details = error as (Error & { code?: number | string; killed?: boolean }) | null;
      resolveResult({
        command, args, exitCode: typeof details?.code === "number" ? details.code : error ? 1 : 0,
        stdout: bounded(String(stdout ?? "")), stderr: bounded(String(stderr ?? "")),
        timedOut: Boolean(details?.killed), durationMs: Date.now() - startedAt,
      });
    });
  });
}

export class WorktreeTools {
  private readonly worktreeRoot: string;
  private readonly options: WorktreeToolOptions;
  private readonly browser: BrowserVerification;
  private readonly visualRegression: VisualRegressionService;
  constructor(options: WorktreeToolOptions) {
    this.options = options;
    this.worktreeRoot = resolve(options.worktreeRoot);
    this.browser = options.browser ?? new BrowserVerification();
    this.visualRegression = options.visualRegression ?? new VisualRegressionService();
  }

  definitions() { return [...Object.values(worktreeToolDefinitions), ...this.browser.definitions()]; }

  private approvedRoot(context: TaskToolContext | undefined): string {
    if (!context?.taskId) throw new Error("An approved task context is required for worktree tools.");
    const approval = this.options.findApproval(context.taskId);
    if (!approval || approval.taskId !== context.taskId || approval.status !== "APPROVED" || !approval.worktreePath || !approval.baseCommit) throw new Error("The task does not have an approved worktree.");
    const configuredRoot = realpathSync(this.worktreeRoot);
    const worktree = realpathSync(approval.worktreePath);
    if (!isInside(configuredRoot, worktree)) throw new Error("The recorded worktree is outside BORG's managed worktree root.");
    return worktree;
  }

  private resolveExisting(root: string, relativePath: unknown): string {
    const path = resolve(root, safeRelativePath(relativePath));
    const realPath = realpathSync(path);
    if (!isInside(root, realPath)) throw new Error("Worktree path escapes through a link.");
    return realPath;
  }

  private resolveWritable(root: string, relativePath: unknown): string {
    const path = resolve(root, safeRelativePath(relativePath));
    if (!isInside(root, path)) throw new Error("Worktree path escapes the approved root.");
    const parent = realpathSync(dirname(path));
    if (!isInside(root, parent)) throw new Error("Worktree path escapes through a parent link.");
    if (existsSync(path) && !isInside(root, realpathSync(path))) throw new Error("Worktree path escapes through a link.");
    return path;
  }

  async execute(name: string, input: Record<string, unknown>, context?: TaskToolContext): Promise<unknown> {
    const root = this.approvedRoot(context);
    if (name === "worktree_read") {
      const path = this.resolveExisting(root, input.path);
      if (!lstatSync(path).isFile() || statSync(path).size > MAX_FILE_BYTES) throw new Error("Worktree file is not a bounded regular file.");
      return { path: relative(root, path), content: readFileSync(path, "utf8") };
    }
    if (name === "worktree_patch") return this.patch(root, input);
    if (name === "worktree_command") return this.command(root, input);
    if (name === "git_status") return this.git(root, ["status", "--short", "--untracked-files=all"]);
    if (name === "git_diff") {
      await this.git(root, ["add", "-N", "--", "."]);
      const args = ["diff", "--no-ext-diff", "--unified=3"];
      if (input.path) args.push("--", safeRelativePath(input.path));
      return this.git(root, args);
    }
    if (name === "verification_profiles") return { profiles: this.profiles(root), visualProfiles: this.visualRegression.profiles(root) };
    if (name.startsWith("browser_")) return this.browser.execute(name, input, { taskId: context!.taskId, worktreePath: root });
    if (name === "verification_run") return this.verify(root, String(input.profile ?? "quick"), context!);
    throw new Error(`Unknown worktree tool: ${name}`);
  }

  private patch(root: string, input: Record<string, unknown>) {
    const path = this.resolveWritable(root, input.path);
    const oldText = String(input.old_text ?? "");
    const newText = String(input.new_text ?? "");
    const expected = Math.max(1, Math.min(100, Math.floor(Number(input.expected_replacements ?? 1))));
    let current = "";
    let created = false;
    if (existsSync(path)) {
      if (!lstatSync(path).isFile() || statSync(path).size > MAX_FILE_BYTES) throw new Error("Worktree file is not a bounded regular file.");
      if (!oldText) throw new Error("old_text may be empty only when creating a new file.");
      current = readFileSync(path, "utf8");
    } else {
      if (oldText) throw new Error("A new file requires empty old_text.");
      created = true;
    }
    const occurrences = oldText ? current.split(oldText).length - 1 : 1;
    if (occurrences !== expected) throw new Error(`Patch expected ${expected} replacement(s) but found ${occurrences}.`);
    const updated = oldText ? current.split(oldText).join(newText) : newText;
    if (Buffer.byteLength(updated, "utf8") > MAX_FILE_BYTES) throw new Error("Patched file exceeds the size limit.");
    const temporaryPath = `${path}.borg-${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, updated, "utf8");
      renameSync(temporaryPath, path);
    } finally {
      if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
    }
    return { path: relative(root, path), created, replacements: occurrences, bytes: Buffer.byteLength(updated, "utf8") };
  }

  private async command(root: string, input: Record<string, unknown>) {
    const command = String(input.command ?? "").toLowerCase();
    const args = Array.isArray(input.args) ? input.args.map(String) : [];
    const cwd = input.cwd ? this.resolveExisting(root, input.cwd) : root;
    if (!statSync(cwd).isDirectory()) throw new Error("Command cwd must be a directory.");
    return runBounded(command, args, cwd, Number(input.timeout_seconds ?? 300));
  }

  private async git(root: string, args: string[]) {
    const result = await new Promise<CommandResult>((resolveResult) => {
      const startedAt = Date.now();
      execFile("git", ["-c", `safe.directory=${root}`, "-C", root, ...args], { timeout: 30_000, maxBuffer: MAX_OUTPUT_BYTES * 2, windowsHide: true }, (error, stdout, stderr) => {
        const details = error as (Error & { code?: number; killed?: boolean }) | null;
        resolveResult({ command: "git", args, exitCode: details?.code ?? (error ? 1 : 0), stdout: bounded(String(stdout ?? "")), stderr: bounded(String(stderr ?? "")), timedOut: Boolean(details?.killed), durationMs: Date.now() - startedAt });
      });
    });
    if (result.exitCode !== 0) throw new Error(result.stderr || "Git command failed.");
    return result;
  }

  private profiles(root: string) {
    const commands: Record<"quick" | "full", VerificationCommand[]> = { quick: [], full: [] };
    const packagePath = join(root, "package.json");
    if (existsSync(packagePath)) {
      const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { scripts?: Record<string, string> };
      const scripts = pkg.scripts ?? {};
      for (const name of ["check", "lint", "test"]) if (scripts[name]) commands.quick.push({ command: "npm", args: ["run", name], label: `npm run ${name}` });
      commands.full.push(...commands.quick);
      if (scripts.build) commands.full.push({ command: "npm", args: ["run", "build"], label: "npm run build" });
    } else if (existsSync(join(root, "Cargo.toml"))) {
      commands.quick.push({ command: "cargo", args: ["test"], label: "cargo test" });
      commands.full.push({ command: "cargo", args: ["check"], label: "cargo check" }, ...commands.quick);
    } else if (existsSync(join(root, "go.mod"))) {
      commands.quick.push({ command: "go", args: ["test", "./..."], label: "go test ./..." });
      commands.full.push(...commands.quick);
    } else if (existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "pytest.ini"))) {
      commands.quick.push({ command: "python", args: ["-m", "pytest"], label: "python -m pytest" });
      commands.full.push(...commands.quick);
    }
    return (["quick", "full"] as const).map((id) => ({ id, commands: commands[id] }));
  }

  private async verify(root: string, profileId: string, context: TaskToolContext) {
    if (profileId !== "quick" && profileId !== "full") throw new Error("Unknown verification profile.");
    const profile = this.profiles(root).find((item) => item.id === profileId)!;
    const results: (CommandResult & { label: string })[] = [];
    let browserEvidence = this.browser.latest(context.taskId);
    try {
      if (!profile.commands.length) throw new Error(`No commands were detected for the ${profileId} verification profile.`);
      for (const command of profile.commands) {
        const result = await runBounded(command.command, command.args, root, MAX_COMMAND_SECONDS);
        results.push({ ...result, label: command.label });
        if (result.exitCode !== 0 || result.timedOut) break;
      }
    } finally {
      browserEvidence = await this.browser.closeForVerification(context.taskId);
    }
    const commandPassed = results.length === profile.commands.length && results.every((item) => item.exitCode === 0 && !item.timedOut);
    const visualRegression = this.visualRegression.compare(root, browserEvidence, profileId);
    return {
      profile: profileId,
      passed: commandPassed && (browserEvidence?.passed ?? true) && visualRegression.passed,
      commandPassed,
      results,
      browserEvidence,
      visualRegression,
    };
  }
}
