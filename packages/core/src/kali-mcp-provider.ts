import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import type { ExecutionNode } from "./security-domain.ts";
import type { SshCredentialResolver } from "./execution-provider.ts";

export const KaliMcpInvocationSchema = z.object({
  mcpTool: z.string().trim().min(1),
  arguments: z.record(z.string(), z.unknown()).default({}),
  timeoutMs: z.number().int().positive().max(60 * 60 * 1000).default(30_000),
  expectedArtifacts: z.array(z.string().trim().min(1)).default([]),
  underlyingExecutable: z.string().trim().min(1).nullable().default(null),
});
export type KaliMcpInvocation = z.infer<typeof KaliMcpInvocationSchema>;

export const KaliMcpCallResultSchema = z.object({
  toolName: z.string().min(1),
  content: z.array(z.unknown()),
  structuredContent: z.record(z.string(), z.unknown()).nullable(),
  isError: z.boolean(),
  text: z.string(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
});
export type KaliMcpCallResult = z.infer<typeof KaliMcpCallResultSchema>;

export type KaliMcpTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

export type KaliMcpHealth = {
  online: true;
  serverName: string;
  serverVersion: string;
  tools: KaliMcpTool[];
  latencyMs: number;
};

type Session = {
  client: Client;
  transport: StdioClientTransport;
  serverName: string;
  serverVersion: string;
  stderr: string[];
};

export type KaliMcpProviderOptions = {
  sshBinary?: string;
  credentialResolver?: SshCredentialResolver | null;
  connectTimeoutSeconds?: number;
  bridgeCommand?: string;
  apiUrl?: string;
};

export interface KaliMcpClientProvider {
  healthCheck(node: ExecutionNode): Promise<KaliMcpHealth>;
  call(node: ExecutionNode, invocation: KaliMcpInvocation, signal?: AbortSignal): Promise<KaliMcpCallResult>;
  disconnect(nodeId: string): Promise<void>;
  close(): Promise<void>;
}

function textFromContent(content: unknown[]): string {
  return content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const value = item as { type?: unknown; text?: unknown };
      return value.type === "text" && typeof value.text === "string" ? value.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

export class KaliMcpProvider implements KaliMcpClientProvider {
  private readonly sshBinary: string;
  private readonly credentialResolver: SshCredentialResolver | null;
  private readonly connectTimeoutSeconds: number;
  private readonly bridgeCommand: string;
  private readonly apiUrl: string;
  private readonly sessions = new Map<string, Promise<Session>>();

  constructor(options: KaliMcpProviderOptions = {}) {
    this.sshBinary = options.sshBinary ?? "ssh";
    this.credentialResolver = options.credentialResolver ?? null;
    this.connectTimeoutSeconds = options.connectTimeoutSeconds ?? 15;
    this.bridgeCommand = options.bridgeCommand ?? "mcp-server";
    this.apiUrl = options.apiUrl ?? "http://127.0.0.1:5000";
  }

  private async connect(node: ExecutionNode): Promise<Session> {
    if (node.provider !== "ssh" || !node.host || !node.username) {
      throw new Error("Kali MCP requires an SSH execution node with a host and username.");
    }
    let identityFile: string | null = null;
    if (node.credentialRef) {
      if (!this.credentialResolver) throw new Error(`Credential ${node.credentialRef} cannot be resolved.`);
      identityFile = (await this.credentialResolver.resolve(node.credentialRef)).identityFile ?? null;
    }
    const args = [
      "-T",
      "-o", "BatchMode=yes",
      "-o", `ConnectTimeout=${this.connectTimeoutSeconds}`,
      "-o", "ConnectionAttempts=3",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
      "-o", "TCPKeepAlive=yes",
      "-p", String(node.port),
    ];
    if (identityFile) args.push("-i", identityFile);
    args.push(`${node.username}@${node.host}`, this.bridgeCommand, "--server", this.apiUrl);

    // The MCP SDK intentionally starts servers with a reduced environment. On
    // Windows that environment is insufficient for the system OpenSSH client,
    // which exits with code 255 before connecting. This child is the trusted
    // local SSH executable, so preserve its normal Windows environment.
    const sshEnvironment = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );

    const transport = new StdioClientTransport({
      command: this.sshBinary,
      args,
      env: sshEnvironment,
      stderr: "pipe",
      maxBufferSize: 4 * 1024 * 1024,
    });
    const stderr: string[] = [];
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderr.join("").length < 8_192) stderr.push(String(chunk));
    });
    const client = new Client({ name: "borg-kali-provider", version: "0.3.0" });
    try {
      await client.connect(transport);
      const version = client.getServerVersion();
      return {
        client,
        transport,
        serverName: version?.name ?? "kali_mcp",
        serverVersion: version?.version ?? "unknown",
        stderr,
      };
    } catch (error) {
      await transport.close().catch(() => undefined);
      const detail = stderr.join("").trim();
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(detail ? `${message}\nKali MCP bridge: ${detail}` : message, { cause: error });
    }
  }

  private session(node: ExecutionNode): Promise<Session> {
    const existing = this.sessions.get(node.id);
    if (existing) return existing;
    const created = this.connect(node).catch((error) => {
      this.sessions.delete(node.id);
      throw error;
    });
    this.sessions.set(node.id, created);
    return created;
  }

  async healthCheck(node: ExecutionNode): Promise<KaliMcpHealth> {
    const started = Date.now();
    const session = await this.session(node);
    let listed;
    try {
      listed = await session.client.listTools();
    } catch (error) {
      const detail = session.stderr.join("").trim();
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(detail ? `${message}\nKali MCP bridge: ${detail}` : message, { cause: error });
    }
    return {
      online: true,
      serverName: session.serverName,
      serverVersion: session.serverVersion,
      tools: listed.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown>,
      })),
      latencyMs: Date.now() - started,
    };
  }

  async call(node: ExecutionNode, invocationInput: KaliMcpInvocation, signal?: AbortSignal): Promise<KaliMcpCallResult> {
    const invocation = KaliMcpInvocationSchema.parse(invocationInput);
    const startedAt = new Date().toISOString();
    const session = await this.session(node);
    try {
      const result = await session.client.callTool(
        { name: invocation.mcpTool, arguments: invocation.arguments },
        undefined,
        { signal, timeout: invocation.timeoutMs, resetTimeoutOnProgress: true },
      );
      const content = Array.isArray(result.content) ? result.content : [];
      return KaliMcpCallResultSchema.parse({
        toolName: invocation.mcpTool,
        content,
        structuredContent: result.structuredContent && typeof result.structuredContent === "object"
          ? result.structuredContent
          : null,
        isError: result.isError === true,
        text: textFromContent(content),
        startedAt,
        finishedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (signal?.aborted) await this.disconnect(node.id);
      throw error;
    }
  }

  async disconnect(nodeId: string): Promise<void> {
    const pending = this.sessions.get(nodeId);
    this.sessions.delete(nodeId);
    if (!pending) return;
    const session = await pending.catch(() => null);
    if (session) await session.transport.close().catch(() => undefined);
  }

  async close(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((nodeId) => this.disconnect(nodeId)));
  }
}
