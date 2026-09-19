import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { BrowserVerification } from "../../browser-verification/src/index.ts";
import { VisualRegressionService } from "../../visual-regression/src/index.ts";
import { ProcessRuntime, type ProcessKind } from "../../process-runtime/src/index.ts";
import type { ExecutionState } from "../../core/src/execution-state.ts";

export interface RecordedApproval {
  taskId: string;
  status: "REQUESTED" | "APPROVED" | "REJECTED";
  worktreePath: string | null;
  baseCommit: string | null;
}

export interface TaskToolContext { taskId: string; executionState?: ExecutionState; }
export interface WorktreeToolOptions {
  worktreeRoot: string;
  findApproval(taskId: string): RecordedApproval | null;
  browser?: BrowserVerification;
  visualRegression?: VisualRegressionService;
  processRuntime?: ProcessRuntime;
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
  worktree_write: {
    type: "function",
    function: {
      name: "worktree_write",
      description: "Create or replace a text file inside the approved task worktree. Missing parent directories are created safely and automatically.",
      parameters: {
        type: "object", required: ["path", "content"],
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          overwrite: { type: "boolean" },
        },
      },
    },
  },
  worktree_patch: {
    type: "function",
    function: {
      name: "worktree_patch",
      description: "Apply an exact text replacement inside the approved task worktree. To create a new file, use an empty old_text and a path that does not exist. Missing parent directories are created safely and automatically.",
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
      description: "Run a bounded command that exits inside the approved task worktree without a shell. Use browser_server_start for persistent development servers; never run npm dev/start/serve/preview here.",
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

async function runBounded(
  command: string,
  args: string[],
  cwd: string,
  timeoutSeconds: number,
  runtime?: ProcessRuntime,
  taskId?: string,
  kind: ProcessKind = "command",
  label?: string,
): Promise<CommandResult> {
  if (!allowedCommands.has(command)) throw new Error(`Command is not allowlisted: ${command}`);
  if (args.length > 40 || args.some((argument) => argument.length > 1_000 || argument.includes("\0"))) throw new Error("Command arguments exceed the bounded command policy.");
  if (runtime && taskId) {
    const result = await runtime.run({
      taskId,
      kind,
      label: label ?? [command, ...args].join(" "),
      command,
      args,
      cwd,
      timeoutMs: Math.max(1, Math.min(MAX_COMMAND_SECONDS, timeoutSeconds)) * 1_000,
    });
    return {
      command,
      args,
      exitCode: result.exitCode ?? (result.status === "completed" ? 0 : 1),
      stdout: bounded(result.stdout),
      stderr: bounded(result.stderr),
      timedOut: result.timedOut,
      durationMs: result.durationMs ?? 0,
    };
  }
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
  private readonly processRuntime: ProcessRuntime;
  constructor(options: WorktreeToolOptions) {
    this.options = options;
    this.worktreeRoot = resolve(options.worktreeRoot);
    this.processRuntime = options.processRuntime ?? new ProcessRuntime();
    this.browser = options.browser ?? new BrowserVerification({ processRuntime: this.processRuntime });
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
    let parent = dirname(path);
    while (!existsSync(parent)) {
      if (parent === root || parent === dirname(parent)) throw new Error("Worktree parent is unavailable.");
      parent = dirname(parent);
    }
    if (!statSync(parent).isDirectory() || !isInside(root, realpathSync(parent))) throw new Error("Worktree path escapes through a parent link.");
    if (existsSync(path) && !isInside(root, realpathSync(path))) throw new Error("Worktree path escapes through a link.");
    return path;
  }

  private ensureWritableParent(root: string, path: string): void {
    const parent = dirname(path);
    mkdirSync(parent, { recursive: true });
    const realParent = realpathSync(parent);
    if (!statSync(realParent).isDirectory() || !isInside(root, realParent)) throw new Error("Worktree path escapes through a parent link.");
  }

  private atomicWrite(root: string, path: string, value: string): void {
    if (Buffer.byteLength(value, "utf8") > MAX_FILE_BYTES) throw new Error("Worktree file exceeds the size limit.");
    this.ensureWritableParent(root, path);
    const temporaryPath = `${path}.borg-${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, value, "utf8");
      renameSync(temporaryPath, path);
    } finally {
      if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
    }
  }

  async execute(name: string, input: Record<string, unknown>, context?: TaskToolContext): Promise<unknown> {
    const root = this.approvedRoot(context);
    if (name === "worktree_read") {
      const path = this.resolveExisting(root, input.path);
      if (!lstatSync(path).isFile() || statSync(path).size > MAX_FILE_BYTES) throw new Error("Worktree file is not a bounded regular file.");
      return { path: relative(root, path), content: readFileSync(path, "utf8") };
    }
    if (name === "worktree_write") return this.write(root, input);
    if (name === "worktree_patch") return this.patch(root, input);
    if (name === "worktree_command") return this.command(root, input, context!);
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

  private write(root: string, input: Record<string, unknown>) {
    const path = this.resolveWritable(root, input.path);
    const value = String(input.content ?? "");
    const overwrite = input.overwrite === true;
    const created = !existsSync(path);
    if (!created) {
      if (!lstatSync(path).isFile() || statSync(path).size > MAX_FILE_BYTES) throw new Error("Worktree file is not a bounded regular file.");
      if (!overwrite) throw new Error("Worktree file already exists. Set overwrite=true to replace it.");
    }
    this.atomicWrite(root, path, value);
    return { path: relative(root, path), created, overwritten: !created, bytes: Buffer.byteLength(value, "utf8") };
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
    const lineEnding = current.includes("\r\n") ? "\r\n" : "\n";
    const matchText = oldText && !current.includes(oldText)
      ? oldText.replace(/\r\n|\n/g, lineEnding)
      : oldText;
    const replacementText = matchText === oldText
      ? newText
      : newText.replace(/\r\n|\n/g, lineEnding);
    const occurrences = matchText ? current.split(matchText).length - 1 : 1;
    if (occurrences !== expected) throw new Error(`Patch expected ${expected} replacement(s) but found ${occurrences}.`);
    const updated = matchText ? current.split(matchText).join(replacementText) : newText;
    if (Buffer.byteLength(updated, "utf8") > MAX_FILE_BYTES) throw new Error("Patched file exceeds the size limit.");
    this.atomicWrite(root, path, updated);
    return { path: relative(root, path), created, replacements: occurrences, bytes: Buffer.byteLength(updated, "utf8") };
  }

  private async command(root: string, input: Record<string, unknown>, context: TaskToolContext) {
    const command = String(input.command ?? "").toLowerCase();
    const args = Array.isArray(input.args) ? input.args.map(String) : [];
    const npmScript = command === "npm" && (args[0]?.toLowerCase() === "run" ? args[1] : args[0]);
    if (npmScript && ["dev", "start", "serve", "preview"].includes(npmScript.toLowerCase())) {
      throw new Error("Persistent development servers must use browser_server_start, which reuses the task preview URL.");
    }
    const cwd = input.cwd ? this.resolveExisting(root, input.cwd) : root;
    if (!statSync(cwd).isDirectory()) throw new Error("Command cwd must be a directory.");
    const kind: ProcessKind = args.some((value) => /(^|:)test$/.test(value)) ? "test"
      : args.some((value) => /(^|:)build$/.test(value)) ? "build"
        : "command";
    return runBounded(
      command,
      args,
      cwd,
      Number(input.timeout_seconds ?? 300),
      this.processRuntime,
      context.taskId,
      kind,
      [command, ...args].join(" "),
    );
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
      if (!commands.quick.length && scripts.build) commands.quick.push({ command: "npm", args: ["run", "build"], label: "npm run build" });
      commands.full.push(...commands.quick);
      if (scripts.build && !commands.quick.some((item) => item.args[1] === "build")) commands.full.push({ command: "npm", args: ["run", "build"], label: "npm run build" });
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
        const result = await runBounded(command.command, command.args, root, MAX_COMMAND_SECONDS, this.processRuntime, context.taskId, "verification", command.label);
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
