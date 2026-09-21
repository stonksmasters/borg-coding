import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { BrowserVerification, type BrowserEvidenceReport } from "../../browser-verification/src/index.ts";
import { VisualRegressionService } from "../../visual-regression/src/index.ts";
import { ProcessRuntime, type ProcessKind } from "../../process-runtime/src/index.ts";
import type { TaskState, WorkflowState } from "../../core/src/contracts.ts";

export interface RecordedApproval {
  taskId: string;
  status: "REQUESTED" | "APPROVED" | "REJECTED";
  worktreePath: string | null;
  baseCommit: string | null;
}

export interface TaskToolContext {
  taskId: string;
  taskState?: TaskState;
  attemptPhase?: WorkflowState["attemptPhase"];
}
export interface WorktreeToolOptions {
  worktreeRoot: string;
  findApproval(taskId: string): RecordedApproval | null;
  browser?: BrowserVerification;
  visualRegression?: VisualRegressionService;
  processRuntime?: ProcessRuntime;
  environmentForTask?: (taskId: string) => Record<string, string>;
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

function plannedRoutes(root: string): string[] {
  const pagesPath = join(root, ".localcode", "build", "pages.json");
  if (!existsSync(pagesPath) || !lstatSync(pagesPath).isFile()) return [];
  try {
    const parsed = JSON.parse(readFileSync(pagesPath, "utf8")) as { pages?: Array<{ route?: string | null }> };
    return (parsed.pages ?? []).map((page) => String(page.route ?? "")).filter((route) => route.startsWith("/"));
  } catch {
    return [];
  }
}

function routeMatches(pathname: string, planned: string) {
  const segments = (value: string) => value.split("/").filter(Boolean);
  const actual = segments(pathname);
  const expected = segments(planned);
  if (actual.length !== expected.length) return false;
  return expected.every((segment, index) =>
    segment.startsWith(":") || /^\[[^\]]+\]$/.test(segment) || segment === actual[index]);
}

export function validateBrowserEvidence(evidence: BrowserEvidenceReport | null, commandPassed: boolean, routes: string[] = []): BrowserEvidenceReport | null {
  if (!evidence) return null;
  const issues = [...evidence.issues];
  if (!commandPassed) issues.push("Browser evidence was not accepted because deterministic verification commands failed.");
  if (evidence.dom.some((node) => node.text?.includes("BORG is preparing the approved design."))) {
    issues.push("Preview still shows the BORG starter placeholder; implemented UI is not connected to the application entrypoint.");
  }
  const placeholderPattern = /\b(?:lorem ipsum|coming soon|placeholder(?: text)?|todo:|dashboard content will be displayed here|content will be displayed here|replace me|sample content)\b/i;
  const placeholderNode = evidence.dom.find((node) => node.visible && placeholderPattern.test(node.text ?? ""));
  if (placeholderNode) {
    issues.push(`Visible placeholder or filler content remains in the rendered product: "${placeholderNode.text.slice(0, 160)}".`);
  }
  const deadButtons = evidence.dom.filter((node) =>
    node.visible && node.tag === "button" && !node.disabled && node.actionable === false);
  if (deadButtons.length) {
    const labels = deadButtons.slice(0, 5).map((node) => node.name || node.text || node.selector);
    issues.push(`Visible enabled controls appear to have no action: ${labels.join(", ")}.`);
  }
  const inertLinks = evidence.dom.filter((node) =>
    node.visible && node.tag === "a" && !node.disabled && node.actionable === false);
  if (inertLinks.length) {
    const labels = inertLinks.slice(0, 5).map((node) => node.name || node.text || node.selector);
    issues.push(`Visible links have no meaningful destination: ${labels.join(", ")}.`);
  }
  if (routes.length && evidence.url) {
    const current = new URL(evidence.url);
    const invalidRoutes = evidence.dom.flatMap((node) => {
      if (!node.visible || node.tag !== "a" || !node.href) return [];
      let href: URL;
      try { href = new URL(node.href); } catch { return []; }
      if (href.origin !== current.origin) return [];
      if (href.hash && href.pathname === current.pathname) return [];
      return routes.some((route) => routeMatches(href.pathname, route))
        ? []
        : [`${node.name || node.text || node.selector} -> ${href.pathname}`];
    });
    if (invalidRoutes.length) {
      issues.push(`Visible internal links point outside the approved page registry: ${[...new Set(invalidRoutes)].slice(0, 8).join(", ")}.`);
    }
  }
  return issues.length === evidence.issues.length ? evidence : { ...evidence, passed: false, issues };
}

export const worktreeToolDefinitions = {
  worktree_list: {
    type: "function",
    function: {
      name: "worktree_list",
      description: "List real files and directories inside the approved task worktree before choosing paths to read or edit.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          depth: { type: "integer", minimum: 0, maximum: 5 },
          max_entries: { type: "integer", minimum: 1, maximum: 500 },
        },
      },
    },
  },
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

type StyleContractViolation = { path: string; line: number; message: string };

function changedSourcePathsFromStatus(status: string) {
  return [...new Set(status.split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .map((value) => value.includes(" -> ") ? value.split(" -> ").at(-1)!.trim() : value)
    .map((value) => value.replaceAll("\\", "/"))
    .filter((value) => value && !value.startsWith(".localcode/") && /\.(?:tsx?|jsx?|css|scss|html)$/.test(value)))];
}

function styleContractViolations(root: string, paths: readonly string[]): StyleContractViolation[] {
  const stylesPath = join(root, ".localcode", "build", "styles.md");
  if (!existsSync(stylesPath) || !lstatSync(stylesPath).isFile()) return [];
  const contract = readFileSync(stylesPath, "utf8").toLowerCase();
  const forbidsPills = /## avoid[\s\S]*\bpills?\b/.test(contract);
  const forbidsGradients = /## avoid[\s\S]*\bgradients?\b/.test(contract);
  const forbidsGlass = /## avoid[\s\S]*\bglass(?:morphism)?\b/.test(contract);
  if (!forbidsPills && !forbidsGradients && !forbidsGlass) return [];

  const violations: StyleContractViolation[] = [];
  for (const relativePath of paths.slice(0, 40)) {
    const absolute = join(root, relativePath);
    if (!existsSync(absolute) || !lstatSync(absolute).isFile() || statSync(absolute).size > MAX_FILE_BYTES) continue;
    const lines = readFileSync(absolute, "utf8").split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (forbidsPills && /\brounded-full\b/.test(line)) {
        violations.push({ path: relativePath, line: index + 1, message: "Approved global styles forbid pill-shaped treatment; rounded-full violates the style contract." });
      }
      if (forbidsGradients && /\b(?:bg-gradient-|from-[\w\[-]|via-[\w\[-]|to-[\w\[-])|(?:linear|radial)-gradient\s*\(/i.test(line)) {
        violations.push({ path: relativePath, line: index + 1, message: "Approved global styles forbid gradients; remove the gradient treatment." });
      }
      if (forbidsGlass && /\bbackdrop-(?:blur|filter)\b|backdrop-filter\s*:/i.test(line)) {
        violations.push({ path: relativePath, line: index + 1, message: "Approved global styles forbid glassmorphism; remove backdrop glass treatment." });
      }
      if (violations.length >= 20) return violations;
    }
  }
  return violations;
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
  environment: Record<string, string> = {},
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
      env: environment,
      redact: Object.values(environment),
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
      env: { ...process.env, CI: "1", NO_COLOR: "1", ...environment },
    }, (error, stdout, stderr) => {
      if (error && typeof (error as NodeJS.ErrnoException).code === "string" && (error as NodeJS.ErrnoException).code === "ENOENT") return reject(new Error(`Command was not found: ${command}`));
      const details = error as (Error & { code?: number | string; killed?: boolean }) | null;
      resolveResult({
        command, args, exitCode: typeof details?.code === "number" ? details.code : error ? 1 : 0,
        stdout: bounded(Object.values(environment).filter(Boolean).reduce((value, secret) => value.split(secret).join("***"), String(stdout ?? ""))),
        stderr: bounded(Object.values(environment).filter(Boolean).reduce((value, secret) => value.split(secret).join("***"), String(stderr ?? ""))),
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
    this.browser = options.browser ?? new BrowserVerification({ processRuntime: this.processRuntime, environmentForTask: options.environmentForTask });
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
    if (name === "worktree_list") return this.list(root, input);
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

  private list(root: string, input: Record<string, unknown>) {
    const requested = String(input.path ?? "").trim().replaceAll("\\", "/");
    const start = requested && requested !== "." ? this.resolveExisting(root, requested) : root;
    if (!statSync(start).isDirectory()) throw new Error("Worktree list path must be a directory.");
    const maximumDepth = Math.max(0, Math.min(5, Math.floor(Number(input.depth ?? 3))));
    const maximumEntries = Math.max(1, Math.min(500, Math.floor(Number(input.max_entries ?? 300))));
    const entries: { path: string; type: "file" | "directory" }[] = [];
    const visit = (directory: string, depth: number) => {
      if (entries.length >= maximumEntries) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entries.length >= maximumEntries) return;
        if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist") continue;
        const candidate = join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        const type = entry.isDirectory() ? "directory" as const : "file" as const;
        entries.push({ path: relative(root, candidate).replaceAll("\\", "/"), type });
        if (type === "directory" && depth < maximumDepth) visit(candidate, depth + 1);
      }
    };
    visit(start, 0);
    return { root: relative(root, start).replaceAll("\\", "/") || ".", entries, truncated: entries.length >= maximumEntries };
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
    if (command === "npm" && args[0]?.toLowerCase() === "run" && args[1]) {
      let packageDirectory = cwd;
      let packagePath = "";
      while (isInside(root, packageDirectory)) {
        const candidate = join(packageDirectory, "package.json");
        if (existsSync(candidate) && lstatSync(candidate).isFile()) {
          packagePath = candidate;
          break;
        }
        if (packageDirectory === root) break;
        const parent = dirname(packageDirectory);
        if (parent === packageDirectory) break;
        packageDirectory = parent;
      }
      if (!packagePath) throw new Error(`Tool usage error: npm run ${args[1]} cannot run because no package.json exists in the approved worktree scope.`);
      const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { scripts?: Record<string, string> };
      if (!pkg.scripts?.[args[1]]) {
        throw new Error(`Tool usage error: npm script "${args[1]}" is not defined in package.json. Use verification_profiles or return control to BORG's deterministic verifier instead of guessing scripts.`);
      }
    }
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
      this.options.environmentForTask?.(context.taskId) ?? {},
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
    let commandPassed = false;
    try {
      if (!profile.commands.length) throw new Error(`No commands were detected for the ${profileId} verification profile.`);
      for (const command of profile.commands) {
        const result = await runBounded(command.command, command.args, root, MAX_COMMAND_SECONDS, this.processRuntime, context.taskId, "verification", command.label, this.options.environmentForTask?.(context.taskId) ?? {});
        results.push({ ...result, label: command.label });
        if (result.exitCode !== 0 || result.timedOut) break;
      }
      commandPassed = results.length === profile.commands.length && results.every((item) => item.exitCode === 0 && !item.timedOut);
      if (commandPassed) {
        const status = await this.git(root, ["status", "--short", "--untracked-files=all"]);
        const violations = styleContractViolations(root, changedSourcePathsFromStatus(status.stdout));
        if (violations.length) {
          const stderr = violations.map((violation) =>
            `${violation.path}:${violation.line}:1: error BORG_STYLE: ${violation.message}`
          ).join("\n");
          results.push({
            command: "borg",
            args: ["style-contract"],
            exitCode: 1,
            stdout: "",
            stderr,
            timedOut: false,
            durationMs: 0,
            label: "BORG style contract",
          });
          commandPassed = false;
        }
      }
    } finally {
      if (commandPassed) await this.browser.ensureEvidenceForVerification({ taskId: context.taskId, worktreePath: root }).catch(() => null);
      browserEvidence = await this.browser.closeForVerification(context.taskId);
    }
    browserEvidence = validateBrowserEvidence(browserEvidence, commandPassed, plannedRoutes(root));
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
