import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { z } from "zod";
import {
  ExecutionNodeSchema,
  type ExecutionNode,
} from "./security-domain.ts";

export const ExecutionRequestSchema = z.object({
  id: z.string().min(1),
  nodeId: z.string().min(1),
  assessmentId: z.string().min(1).nullable().default(null),
  taskId: z.string().min(1).nullable().default(null),
  executable: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1).nullable().default(null),
  timeoutMs: z.number().int().positive().max(60 * 60 * 1000).default(30_000),
  createdAt: z.string().datetime(),
});
export type ExecutionRequest = z.infer<typeof ExecutionRequestSchema>;

export const ExecutionResultSchema = z.object({
  requestId: z.string().min(1),
  nodeId: z.string().min(1),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  timedOut: z.boolean(),
  cancelled: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
  stdoutTruncated: z.boolean(),
  stderrTruncated: z.boolean(),
});
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;

export type ExecutionOutputChunk = {
  stream: "stdout" | "stderr";
  text: string;
};

export type ExecutionOptions = {
  signal?: AbortSignal;
  onOutput?: (chunk: ExecutionOutputChunk) => void;
};

export type NodeHealth = {
  online: true;
  platform: string;
  architecture: string;
  latencyMs: number;
};

export interface ExecutionProvider {
  readonly kind: ExecutionNode["provider"];
  execute(node: ExecutionNode, request: ExecutionRequest, options?: ExecutionOptions): Promise<ExecutionResult>;
  healthCheck(node: ExecutionNode, options?: ExecutionOptions): Promise<NodeHealth>;
}

export type SshCredential = {
  identityFile?: string | null;
};

export interface SshCredentialResolver {
  resolve(reference: string): Promise<SshCredential>;
}

export type SshExecutionProviderOptions = {
  sshBinary?: string;
  credentialResolver?: SshCredentialResolver | null;
  connectTimeoutSeconds?: number;
  maxCaptureBytes?: number;
};

export function createExecutionRequest(input: {
  nodeId: string;
  executable: string;
  args?: string[];
  cwd?: string | null;
  timeoutMs?: number;
  assessmentId?: string | null;
  taskId?: string | null;
  id?: string;
}): ExecutionRequest {
  return ExecutionRequestSchema.parse({
    id: input.id ?? randomUUID(),
    nodeId: input.nodeId,
    assessmentId: input.assessmentId ?? null,
    taskId: input.taskId ?? null,
    executable: input.executable,
    args: input.args ?? [],
    cwd: input.cwd ?? null,
    timeoutMs: input.timeoutMs ?? 30_000,
    createdAt: new Date().toISOString(),
  });
}

function assertSafeRemoteExecutable(executable: string): string {
  if (!/^[A-Za-z0-9_./+-]+$/.test(executable)) {
    throw new Error(`Remote executable contains unsupported characters: ${executable}`);
  }
  return executable;
}

export function quotePosixArgument(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error("Remote arguments may not contain NUL or newline characters.");
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function buildRemoteCommand(request: ExecutionRequest): string {
  const value = ExecutionRequestSchema.parse(request);
  const executable = assertSafeRemoteExecutable(value.executable);
  const command = [quotePosixArgument(executable), ...value.args.map(quotePosixArgument)].join(" ");
  if (!value.cwd) return `exec ${command}`;
  return `cd ${quotePosixArgument(value.cwd)} && exec ${command}`;
}

function appendBounded(current: Buffer, chunk: Buffer, limit: number): { value: Buffer; truncated: boolean } {
  if (current.length >= limit) return { value: current, truncated: chunk.length > 0 };
  const remaining = limit - current.length;
  if (chunk.length <= remaining) return { value: Buffer.concat([current, chunk]), truncated: false };
  return { value: Buffer.concat([current, chunk.subarray(0, remaining)]), truncated: true };
}

export class SshExecutionProvider implements ExecutionProvider {
  readonly kind = "ssh" as const;
  private readonly sshBinary: string;
  private readonly credentialResolver: SshCredentialResolver | null;
  private readonly connectTimeoutSeconds: number;
  private readonly maxCaptureBytes: number;

  constructor(options: SshExecutionProviderOptions = {}) {
    this.sshBinary = options.sshBinary ?? "ssh";
    this.credentialResolver = options.credentialResolver ?? null;
    this.connectTimeoutSeconds = options.connectTimeoutSeconds ?? 15;
    this.maxCaptureBytes = options.maxCaptureBytes ?? 1024 * 1024;
  }

  async execute(nodeInput: ExecutionNode, requestInput: ExecutionRequest, options: ExecutionOptions = {}): Promise<ExecutionResult> {
    const node = ExecutionNodeSchema.parse(nodeInput);
    const request = ExecutionRequestSchema.parse(requestInput);
    if (node.provider !== "ssh") throw new Error(`SSH provider cannot execute against ${node.provider} node ${node.id}.`);
    if (request.nodeId !== node.id) throw new Error(`Execution request targets node ${request.nodeId}, not ${node.id}.`);
    if (!node.host || !node.username) throw new Error("SSH node is missing host or username.");

    let credential: SshCredential = {};
    if (node.credentialRef) {
      if (!this.credentialResolver) {
        throw new Error(`SSH credential reference ${node.credentialRef} cannot be resolved because no credential resolver is configured.`);
      }
      credential = await this.credentialResolver.resolve(node.credentialRef);
    }

    const remoteCommand = buildRemoteCommand(request);
    const sshArgs = [
      "-T",
      "-o", "BatchMode=yes",
      "-o", `ConnectTimeout=${this.connectTimeoutSeconds}`,
      "-o", "ConnectionAttempts=3",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
      "-o", "TCPKeepAlive=yes",
      "-p", String(node.port),
    ];
    if (credential.identityFile) sshArgs.push("-i", credential.identityFile);
    sshArgs.push(`${node.username}@${node.host}`, remoteCommand);

    const startedAt = new Date();
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let cancelled = options.signal?.aborted ?? false;

    if (cancelled) {
      const finishedAt = new Date();
      return ExecutionResultSchema.parse({
        requestId: request.id,
        nodeId: node.id,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        exitCode: null,
        signal: null,
        timedOut: false,
        cancelled: true,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      });
    }

    return await new Promise<ExecutionResult>((resolve, reject) => {
      const child = spawn(this.sshBinary, sshArgs, {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let timeout: NodeJS.Timeout | null = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, request.timeoutMs);

      const abort = () => {
        cancelled = true;
        child.kill();
      };
      options.signal?.addEventListener("abort", abort, { once: true });

      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        timeout = null;
        options.signal?.removeEventListener("abort", abort);
      };

      child.stdout.on("data", (value: Buffer | string) => {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        const appended = appendBounded(stdout, chunk, this.maxCaptureBytes);
        stdout = appended.value;
        stdoutTruncated ||= appended.truncated;
        options.onOutput?.({ stream: "stdout", text: chunk.toString("utf8") });
      });

      child.stderr.on("data", (value: Buffer | string) => {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        const appended = appendBounded(stderr, chunk, this.maxCaptureBytes);
        stderr = appended.value;
        stderrTruncated ||= appended.truncated;
        options.onOutput?.({ stream: "stderr", text: chunk.toString("utf8") });
      });

      child.once("error", (error) => {
        cleanup();
        reject(error);
      });

      child.once("close", (exitCode, signal) => {
        cleanup();
        resolve(ExecutionResultSchema.parse({
          requestId: request.id,
          nodeId: node.id,
          startedAt: startedAt.toISOString(),
          finishedAt: new Date().toISOString(),
          exitCode,
          signal,
          timedOut,
          cancelled,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
          stdoutTruncated,
          stderrTruncated,
        }));
      });
    });
  }

  async healthCheck(node: ExecutionNode, options: ExecutionOptions = {}): Promise<NodeHealth> {
    const started = Date.now();
    const platform = await this.execute(node, createExecutionRequest({
      nodeId: node.id,
      executable: "uname",
      args: ["-s"],
      timeoutMs: 20_000,
    }), options);
    if (platform.exitCode !== 0) throw new Error(platform.stderr.trim() || "Unable to read remote platform.");

    const architecture = await this.execute(node, createExecutionRequest({
      nodeId: node.id,
      executable: "uname",
      args: ["-m"],
      timeoutMs: 20_000,
    }), options);
    if (architecture.exitCode !== 0) throw new Error(architecture.stderr.trim() || "Unable to read remote architecture.");

    return {
      online: true,
      platform: platform.stdout.trim() || "unknown",
      architecture: architecture.stdout.trim() || "unknown",
      latencyMs: Date.now() - started,
    };
  }
}
