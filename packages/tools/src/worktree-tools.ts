import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ApprovalRecord } from "../../core/src/contracts.ts";

const MAX_FILE_BYTES = 1_000_000;
const MAX_OUTPUT_BYTES = 160_000;
const MAX_COMMAND_SECONDS = Math.max(1, Math.min(900, Number(process.env.BORG_COMMAND_TIMEOUT_SECONDS ?? 900)));
const MAX_REPLACEMENTS = 500;
const allowedCommands = new Set(["npm", "node", "git"]);

export interface TaskToolContext { taskId: string; }
export interface WorktreeToolOptions {
  worktreeRoot: string;
  findApproval: (taskId: string) => ApprovalRecord | null;
}

interface CommandResult { command: string; args: string[]; exitCode: number; stdout: string; stderr: string; timedOut: boolean; durationMs: number; }

const worktreeToolDefinitions = {
  worktree_read: {
    type: "function",
    function: {
      name: "worktree_read",
      description: "Read a text/source file from the approved task worktree using a worktree-relative path.",
      parameters: { type: "object", required: ["path"], properties: { path: { type: "string" }, max_characters: { type: "integer", minimum: 1, maximum: 100000 } } },
    },
  },
  worktree_patch: {
    type: "function",
    function: {
      name: "worktree_patch",
      description: "Replace exact text in a source file inside the approved task worktree. The old text must exist and is replaced atomically. Use replace_all only when every exact occurrence should change.",
      parameters: { type: "object", required: ["path", "old_text", "new_text"], properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" }, replace_all: { type: "boolean" } } },
    },
  },
  worktree_command: {
    type: "function",
    function: {
      name: "worktree_command",
      description: "Run a bounded allowlisted development command inside the approved task worktree. Executable must be npm, node, or git and no shell interpolation is performed.",
      parameters: { type: "object", required: ["command"], properties: { command: { type: "string", enum: ["npm", "node", "git"] }, args: { type: "array", items: { type: "string" }, maxItems: 40 }, timeout_seconds: { type: "integer", minimum: 1, maximum: 900 } } },
    },
  },
  git_status: {
    type: "function",
    function: { name: "git_status", description: "Show bounded Git status for the approved task worktree.", parameters: { type: "object", properties: {} } },
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
  constructor(options: WorktreeToolOptions) {
    this.options = options;
    this.worktreeRoot = resolve(options.worktreeRoot);
  }

  definitions() { return Object.values(worktreeToolDefinitions); }

  async execute(name: string, args: Record<string, unknown>, context?: TaskToolContext): Promise<unknown> {
    const approved = this.approved(context);
    if (name === "worktree_read") return this.read(approved.worktreePath, args);
    if (name === "worktree_patch") return this.patch(approved.worktreePath, args);
    if (name === "worktree_command") return runBounded(String(args.command ?? ""), Array.isArray(args.args) ? args.args.map(String) : [], approved.worktreePath, Number(args.timeout_seconds ?? MAX_COMMAND_SECONDS));
    if (name === "git_status") return runBounded("git", ["status", "--short", "--untracked-files=all"], approved.worktreePath, 30);
    if (name === "git_diff") return this.diff(approved.worktreePath, args);
    if (name === "verification_profiles") return this.profiles(approved.worktreePath);
    if (name === "verification_run") return this.verify(approved.worktreePath, String(args.profile ?? "quick"));
    throw new Error(`Unknown worktree tool: ${name}`);
  }

  private approved(context?: TaskToolContext) {
    if (!context?.taskId) throw new Error("Task context is required for mutating tools.");
    const approval = this.options.findApproval(context.taskId);
    if (!approval || approval.status !== "APPROVED" || !approval.worktreePath || !approval.baseCommit) throw new Error("Task does not have an approved worktree.");
    const root = realpathSync(this.worktreeRoot);
    const worktreePath = realpathSync(approval.worktreePath);
    if (!isInside(root, worktreePath)) throw new Error("Approved worktree is outside BORG's worktree root.");
    return { approval, worktreePath };
  }

  private file(worktreePath: string, inputPath: unknown, requireExisting = true) {
    const relativePath = safeRelativePath(inputPath);
    const candidate = resolve(worktreePath, relativePath);
    if (!isInside(worktreePath, candidate)) throw new Error("Path leaves the approved task worktree.");
    if (requireExisting && !existsSync(candidate)) throw new Error(`Worktree path does not exist: ${relativePath}`);
    if (existsSync(candidate)) {
      const details = lstatSync(candidate);
      if (details.isSymbolicLink()) throw new Error("Symbolic-link file access is not allowed.");
      const real = realpathSync(candidate);
      if (!isInside(worktreePath, real)) throw new Error("Resolved file leaves the approved task worktree.");
    }
    return { absolute: candidate, relativePath: relative(worktreePath, candidate).replaceAll("\\", "/") };
  }

  private read(worktreePath: string, args: Record<string, unknown>) {
    const file = this.file(worktreePath, args.path);
    if (!statSync(file.absolute).isFile()) throw new Error("Path must identify a file.");
    const size = statSync(file.absolute).size;
    if (size > MAX_FILE_BYTES) throw new Error("File is too large for bounded worktree reading.");
    const max = Math.max(1, Math.min(100_000, Number(args.max_characters ?? 60_000)));
    const raw = readFileSync(file.absolute, "utf8");
    return { path: file.relativePath, content: raw.slice(0, max), truncated: raw.length > max };
  }

  private patch(worktreePath: string, args: Record<string, unknown>) {
    const file = this.file(worktreePath, args.path);
    if (!statSync(file.absolute).isFile()) throw new Error("Path must identify a file.");
    const before = readFileSync(file.absolute, "utf8");
    if (Buffer.byteLength(before, "utf8") > MAX_FILE_BYTES) throw new Error("File is too large for bounded patching.");
    const oldText = String(args.old_text ?? "");
    const newText = String(args.new_text ?? "");
    if (!oldText || oldText.length > 100_000 || newText.length > 200_000) throw new Error("Patch text exceeds the bounded patch policy.");
    const occurrences = before.split(oldText).length - 1;
    if (occurrences === 0) throw new Error("Exact old_text was not found; inspect the current file before patching.");
    const replaceAll = args.replace_all === true;
    if (!replaceAll && occurrences !== 1) throw new Error(`old_text matched ${occurrences} locations; provide more context or set replace_all intentionally.`);
    if (occurrences > MAX_REPLACEMENTS) throw new Error("Patch would replace too many locations.");
    const after = replaceAll ? before.split(oldText).join(newText) : before.replace(oldText, newText);
    const temporary = `${file.absolute}.borg-tmp-${process.pid}-${Date.now()}`;
    writeFileSync(temporary, after, "utf8");
    renameSync(temporary, file.absolute);
    return { path: file.relativePath, replacements: replaceAll ? occurrences : 1, bytesBefore: Buffer.byteLength(before), bytesAfter: Buffer.byteLength(after) };
  }

  private async diff(worktreePath: string, args: Record<string, unknown>) {
    const path = String(args.path ?? "").trim();
    if (!path) return runBounded("git", ["diff", "--no-ext-diff", "--binary"], worktreePath, 45);
    const safePath = safeRelativePath(path);
    return runBounded("git", ["diff", "--no-ext-diff", "--binary", "--", safePath], worktreePath, 45);
  }

  private profiles(worktreePath: string) {
    const packageJson = join(worktreePath, "package.json");
    const pyproject = join(worktreePath, "pyproject.toml");
    const requirements = join(worktreePath, "requirements.txt");
    const cargo = join(worktreePath, "Cargo.toml");
    const goMod = join(worktreePath, "go.mod");
    const quick: { label: string; command: string; args: string[] }[] = [];
    const full: { label: string; command: string; args: string[] }[] = [];

    if (existsSync(packageJson)) {
      const scripts = JSON.parse(readFileSync(packageJson, "utf8")).scripts ?? {};
      for (const name of ["lint", "check", "typecheck"]) if (scripts[name]) quick.push({ label: `npm ${name}`, command: "npm", args: ["run", name] });
      if (scripts.test) full.push({ label: "npm test", command: "npm", args: ["test", "--", "--runInBand"] });
      if (scripts.build) full.push({ label: "npm build", command: "npm", args: ["run", "build"] });
      if (!quick.length && scripts.test) quick.push({ label: "npm test", command: "npm", args: ["test", "--", "--runInBand"] });
    }
    if (existsSync(pyproject) || existsSync(requirements)) {
      if (existsSync(join(worktreePath, "pytest.ini")) || existsSync(join(worktreePath, "tests"))) quick.push({ label: "pytest", command: "python", args: ["-m", "pytest", "-q"] });
    }
    if (existsSync(cargo)) quick.push({ label: "cargo check", command: "cargo", args: ["check"] });
    if (existsSync(cargo)) full.push({ label: "cargo test", command: "cargo", args: ["test"] });
    if (existsSync(goMod)) quick.push({ label: "go test", command: "go", args: ["test", "./..."] });
    return { quick, full: [...quick, ...full] };
  }

  private async verify(worktreePath: string, profile: string) {
    const profiles = this.profiles(worktreePath);
    const selected = profile === "full" ? profiles.full : profiles.quick;
    if (!selected.length) return { profile, passed: true, results: [], message: "No deterministic verification commands were detected for this project." };
    const results = [];
    for (const step of selected) {
      const result = await runBounded(step.command, step.args, worktreePath, MAX_COMMAND_SECONDS);
      results.push({ ...step, ...result });
      if (result.exitCode !== 0 || result.timedOut) return { profile, passed: false, results };
    }
    return { profile, passed: true, results };
  }
}
