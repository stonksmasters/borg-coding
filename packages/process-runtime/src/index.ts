import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

export type ProcessKind = "command" | "dev_server" | "test" | "build" | "verification";
export type ProcessStatus = "starting" | "running" | "completed" | "failed" | "stopped";

export interface ProcessSnapshot {
  id: string;
  taskId: string;
  kind: ProcessKind;
  label: string;
  command: string;
  args: string[];
  cwd: string;
  url: string | null;
  pid: number | null;
  status: ProcessStatus;
  exitCode: number | null;
  timedOut: boolean;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  stdout: string;
  stderr: string;
}

export type ProcessRuntimeEvent =
  | { type: "process.started"; taskId: string; process: ProcessSnapshot; occurredAt: string }
  | { type: "process.output"; taskId: string; processId: string; stream: "stdout" | "stderr"; text: string; occurredAt: string }
  | { type: "process.state"; taskId: string; process: ProcessSnapshot; occurredAt: string };

export interface ProcessStartInput {
  taskId: string;
  kind: ProcessKind;
  label: string;
  command: string;
  args?: string[];
  cwd: string;
  url?: string | null;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

interface ManagedProcess {
  child: ChildProcess;
  snapshot: ProcessSnapshot;
  completion: Promise<ProcessSnapshot>;
  resolveCompletion(value: ProcessSnapshot): void;
  stopRequested: boolean;
  timeout: NodeJS.Timeout | null;
}

const MAX_LOG_BYTES = 160_000;
const MAX_EVENT_CHUNK = 16_000;

function boundedAppend(current: string, value: string): string {
  const next = current + value;
  return next.length > MAX_LOG_BYTES ? next.slice(next.length - MAX_LOG_BYTES) : next;
}

function commandInvocation(command: string, args: string[]) {
  if (command === "node") return { executable: process.execPath, args };
  if (command === "npm") {
    const candidates = [
      process.env.npm_execpath,
      resolve(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
      resolve(dirname(dirname(process.execPath)), "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    ].filter((value): value is string => Boolean(value));
    const npmCli = candidates.find((value) => existsSync(value));
    if (npmCli) return { executable: process.execPath, args: [npmCli, ...args] };
    return { executable: process.platform === "win32" ? "npm.cmd" : "npm", args };
  }
  return { executable: command, args };
}

async function delay(milliseconds: number) {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const closed = new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));
  if (process.platform === "win32" && child.pid) {
    const killedTree = await new Promise<boolean>((resolveStop) => execFile("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }, (error) => resolveStop(!error)));
    if (!killedTree && child.exitCode === null) child.kill("SIGTERM");
  } else if (child.pid) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  } else child.kill("SIGTERM");
  const graceful = await Promise.race([closed.then(() => true), delay(1_500).then(() => false)]);
  if (graceful || child.exitCode !== null) return;
  if (process.platform !== "win32" && child.pid) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  } else child.kill("SIGKILL");
  await Promise.race([closed, delay(1_500)]);
}

export async function findAvailableLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  if (!port) throw new Error("Unable to allocate a local preview port.");
  return port;
}

async function waitForUrl(url: string, timeoutMs: number, processSnapshot: () => ProcessSnapshot) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "No response";
  while (Date.now() < deadline) {
    const snapshot = processSnapshot();
    if (snapshot.status === "failed" || snapshot.status === "completed" || snapshot.status === "stopped") {
      throw new Error(`Development server exited before becoming ready (code ${snapshot.exitCode ?? "unknown"}).`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.status >= 100) return;
    } catch (error) { lastError = error instanceof Error ? error.message : String(error); }
    await delay(250);
  }
  throw new Error(`Development server did not become ready: ${lastError}`);
}

export class ProcessRuntime {
  private readonly processes = new Map<string, ManagedProcess>();
  private readonly onEvent?: (event: ProcessRuntimeEvent) => void;

  constructor(options: { onEvent?: (event: ProcessRuntimeEvent) => void } = {}) {
    this.onEvent = options.onEvent;
  }

  list(taskId: string): ProcessSnapshot[] {
    return [...this.processes.values()]
      .map((value) => ({ ...value.snapshot, args: [...value.snapshot.args] }))
      .filter((value) => value.taskId === taskId)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  findRunning(taskId: string, kind?: ProcessKind): ProcessSnapshot | null {
    const value = [...this.processes.values()].find((record) =>
      record.snapshot.taskId === taskId
      && (!kind || record.snapshot.kind === kind)
      && ["starting", "running"].includes(record.snapshot.status)
    );
    return value ? { ...value.snapshot, args: [...value.snapshot.args] } : null;
  }

  async run(input: ProcessStartInput): Promise<ProcessSnapshot> {
    const record = this.launch(input);
    return record.completion;
  }

  async ensureServer(input: ProcessStartInput & { url: string; startupTimeoutMs?: number }): Promise<ProcessSnapshot> {
    const existing = [...this.processes.values()].find((record) =>
      record.snapshot.taskId === input.taskId
      && record.snapshot.kind === "dev_server"
      && ["starting", "running"].includes(record.snapshot.status)
    );
    if (existing) {
      const same = existing.snapshot.cwd === resolve(input.cwd)
        && existing.snapshot.command === input.command
        && JSON.stringify(existing.snapshot.args) === JSON.stringify(input.args ?? [])
        && existing.snapshot.url === input.url;
      if (same) {
        await waitForUrl(input.url, input.startupTimeoutMs ?? 30_000, () => existing.snapshot);
        return { ...existing.snapshot, args: [...existing.snapshot.args] };
      }
      await this.stop(existing.snapshot.id);
    }

    const record = this.launch({ ...input, kind: "dev_server", timeoutMs: undefined });
    try {
      await waitForUrl(input.url, input.startupTimeoutMs ?? 30_000, () => record.snapshot);
      record.snapshot.status = "running";
      this.emit({ type: "process.state", taskId: input.taskId, process: this.copy(record.snapshot), occurredAt: new Date().toISOString() });
      return this.copy(record.snapshot);
    } catch (error) {
      await this.stop(record.snapshot.id);
      throw error;
    }
  }

  async stop(processId: string): Promise<ProcessSnapshot | null> {
    const record = this.processes.get(processId);
    if (!record) return null;
    if (!["starting", "running"].includes(record.snapshot.status)) return this.copy(record.snapshot);
    record.stopRequested = true;
    if (record.timeout) clearTimeout(record.timeout);
    await stopChild(record.child);
    return record.completion;
  }

  async stopTask(taskId: string, kind?: ProcessKind) {
    const records = [...this.processes.values()].filter((record) =>
      record.snapshot.taskId === taskId
      && (!kind || record.snapshot.kind === kind)
      && ["starting", "running"].includes(record.snapshot.status)
    );
    return Promise.all(records.map((record) => this.stop(record.snapshot.id)));
  }

  async stopAll() {
    const records = [...this.processes.values()].filter((record) => ["starting", "running"].includes(record.snapshot.status));
    await Promise.allSettled(records.map((record) => this.stop(record.snapshot.id)));
  }

  private launch(input: ProcessStartInput): ManagedProcess {
    if (!input.taskId.trim()) throw new Error("Process taskId is required.");
    if (!input.label.trim()) throw new Error("Process label is required.");
    const args = [...(input.args ?? [])];
    if (args.length > 60 || args.some((argument) => argument.length > 2_000 || argument.includes("\0"))) throw new Error("Process arguments exceed the bounded runtime policy.");
    const cwd = resolve(input.cwd);
    const invocation = commandInvocation(input.command, args);
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    const child = spawn(invocation.executable, invocation.args, {
      cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      env: { ...process.env, CI: "1", NO_COLOR: "1", ...input.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let resolveCompletion!: (value: ProcessSnapshot) => void;
    const completion = new Promise<ProcessSnapshot>((resolveResult) => { resolveCompletion = resolveResult; });
    const record: ManagedProcess = {
      child,
      snapshot: {
        id, taskId: input.taskId, kind: input.kind, label: input.label,
        command: input.command, args, cwd, url: input.url ?? null,
        pid: child.pid ?? null, status: "starting", exitCode: null, timedOut: false,
        startedAt, completedAt: null, durationMs: null, stdout: "", stderr: "",
      },
      completion,
      resolveCompletion,
      stopRequested: false,
      timeout: null,
    };
    this.processes.set(id, record);
    this.emit({ type: "process.started", taskId: input.taskId, process: this.copy(record.snapshot), occurredAt: startedAt });

    const push = (stream: "stdout" | "stderr", chunk: Buffer | string) => {
      const text = String(chunk);
      if (!text) return;
      if (stream === "stdout") record.snapshot.stdout = boundedAppend(record.snapshot.stdout, text);
      else record.snapshot.stderr = boundedAppend(record.snapshot.stderr, text);
      this.emit({ type: "process.output", taskId: input.taskId, processId: id, stream, text: text.slice(0, MAX_EVENT_CHUNK), occurredAt: new Date().toISOString() });
    };
    child.stdout?.on("data", (chunk) => push("stdout", chunk));
    child.stderr?.on("data", (chunk) => push("stderr", chunk));

    let finalized = false;
    const finalize = (exitCode: number | null, error?: Error) => {
      if (finalized) return;
      finalized = true;
      if (record.timeout) clearTimeout(record.timeout);
      const completedAt = new Date();
      record.snapshot.exitCode = exitCode;
      record.snapshot.completedAt = completedAt.toISOString();
      record.snapshot.durationMs = completedAt.getTime() - new Date(record.snapshot.startedAt).getTime();
      record.snapshot.status = record.stopRequested ? "stopped" : error || (exitCode !== null && exitCode !== 0) ? "failed" : "completed";
      if (error && !record.snapshot.stderr.includes(error.message)) record.snapshot.stderr = boundedAppend(record.snapshot.stderr, `${error.message}\n`);
      const snapshot = this.copy(record.snapshot);
      this.emit({ type: "process.state", taskId: input.taskId, process: snapshot, occurredAt: completedAt.toISOString() });
      resolveCompletion(snapshot);
    };

    child.once("spawn", () => {
      if (finalized) return;
      record.snapshot.pid = child.pid ?? null;
      record.snapshot.status = "running";
      this.emit({ type: "process.state", taskId: input.taskId, process: this.copy(record.snapshot), occurredAt: new Date().toISOString() });
    });
    child.once("error", (error) => finalize(null, error));
    child.once("close", (code) => finalize(code));

    if (input.timeoutMs && input.timeoutMs > 0) {
      record.timeout = setTimeout(() => {
        if (!["starting", "running"].includes(record.snapshot.status)) return;
        record.snapshot.timedOut = true;
        void this.stop(id);
      }, input.timeoutMs);
    }
    return record;
  }

  private copy(snapshot: ProcessSnapshot): ProcessSnapshot {
    return { ...snapshot, args: [...snapshot.args] };
  }

  private emit(event: ProcessRuntimeEvent) {
    this.onEvent?.(event);
  }
}
