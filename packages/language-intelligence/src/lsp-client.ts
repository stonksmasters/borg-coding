import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface LspClientOptions {
  id: string;
  command: string;
  args: readonly string[];
  cwd: string;
  rootUri: string;
  timeoutMs?: number;
  maxMessageBytes?: number;
}

const MAX_STDERR_CHARACTERS = 20_000;

export class LspClient {
  private readonly options: Required<Pick<LspClientOptions, "timeoutMs" | "maxMessageBytes">> & LspClientOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly diagnosticsByUri = new Map<string, unknown[]>();
  private readonly openedDocuments = new Set<string>();
  private startPromise: Promise<void> | null = null;
  private stderr = "";
  private stopped = false;

  constructor(options: LspClientOptions) {
    this.options = {
      timeoutMs: options.timeoutMs ?? 15_000,
      maxMessageBytes: options.maxMessageBytes ?? 2_000_000,
      ...options,
    };
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error(`${this.options.id} language server is closed.`);
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal().catch((error) => {
      this.startPromise = null;
      throw error;
    });
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    const child = spawn(this.options.command, [...this.options.args], {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      env: { ...process.env, NO_COLOR: "1" },
    });
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-MAX_STDERR_CHARACTERS);
    });
    child.once("error", (error) => this.failAll(new Error(`${this.options.id} failed to start: ${error.message}`)));
    child.once("exit", (code, signal) => {
      this.child = null;
      if (!this.stopped) {
        const detail = this.stderr.trim();
        this.failAll(new Error(`${this.options.id} exited unexpectedly (${code ?? signal ?? "unknown"}).${detail ? ` ${detail}` : ""}`));
      }
    });

    await this.request("initialize", {
      processId: process.pid,
      clientInfo: { name: "BORG Code", version: "0.3" },
      rootUri: this.options.rootUri,
      workspaceFolders: [{ uri: this.options.rootUri, name: "repository" }],
      capabilities: {
        workspace: { symbol: { dynamicRegistration: false } },
        textDocument: {
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          definition: { dynamicRegistration: false, linkSupport: true },
          references: { dynamicRegistration: false },
          implementation: { dynamicRegistration: false, linkSupport: true },
          hover: { dynamicRegistration: false, contentFormat: ["plaintext", "markdown"] },
          diagnostic: { dynamicRegistration: false },
          publishDiagnostics: { relatedInformation: true, versionSupport: true },
        },
        window: { workDoneProgress: false },
      },
      initializationOptions: {},
      trace: "off",
    });
    this.notify("initialized", {});
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (!this.child) {
      if (method === "initialize") {
        if (!this.child) throw new Error(`${this.options.id} language server is not running.`);
      } else {
        await this.start();
      }
    }
    const id = this.nextId++;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.options.id} request timed out: ${method}`));
      }, this.options.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.child) throw new Error(`${this.options.id} language server is not running.`);
    this.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  async openDocument(uri: string, languageId: string, text: string): Promise<void> {
    await this.start();
    if (this.openedDocuments.has(uri)) return;
    this.openedDocuments.add(uri);
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text },
    });
  }

  diagnostics(uri: string): unknown[] {
    return [...(this.diagnosticsByUri.get(uri) ?? [])];
  }

  async waitForDiagnostics(delayMs = 150): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(1_000, delayMs))));
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const child = this.child;
    if (!child) return;
    try {
      await this.request("shutdown");
      this.notify("exit");
    } catch {
      // The process is still terminated below.
    }
    child.kill();
    this.child = null;
    this.failAll(new Error(`${this.options.id} language server was closed.`));
  }

  private send(message: JsonRpcMessage): void {
    if (!this.child?.stdin.writable) throw new Error(`${this.options.id} language server input is unavailable.`);
    const body = JSON.stringify(message);
    const bytes = Buffer.byteLength(body, "utf8");
    if (bytes > this.options.maxMessageBytes) throw new Error(`${this.options.id} message exceeds the bounded LSP size.`);
    this.child.stdin.write(`Content-Length: ${bytes}\r\n\r\n${body}`, "utf8");
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > this.options.maxMessageBytes * 2) {
      this.failAll(new Error(`${this.options.id} emitted an oversized LSP buffer.`));
      this.child?.kill();
      return;
    }

    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = header.match(/(?:^|\r\n)Content-Length:\s*(\d+)/i);
      if (!match) {
        this.failAll(new Error(`${this.options.id} emitted an invalid LSP header.`));
        this.child?.kill();
        return;
      }
      const length = Number(match[1]);
      if (!Number.isInteger(length) || length < 0 || length > this.options.maxMessageBytes) {
        this.failAll(new Error(`${this.options.id} emitted an invalid LSP message length.`));
        this.child?.kill();
        return;
      }
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      try {
        this.handle(JSON.parse(body) as JsonRpcMessage);
      } catch (error) {
        this.failAll(error instanceof Error ? error : new Error(String(error)));
        this.child?.kill();
        return;
      }
    }
  }

  private handle(message: JsonRpcMessage): void {
    if ("id" in message && !("method" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${this.options.id} LSP error ${message.error.code}: ${message.error.message}`));
      else pending.resolve(message.result);
      return;
    }

    if (!("method" in message)) return;
    if (message.method === "textDocument/publishDiagnostics") {
      const params = message.params as { uri?: unknown; diagnostics?: unknown };
      if (typeof params?.uri === "string" && Array.isArray(params.diagnostics)) this.diagnosticsByUri.set(params.uri, params.diagnostics);
      return;
    }

    if ("id" in message) {
      const result = message.method === "workspace/configuration"
        ? Array.from({ length: Array.isArray((message.params as { items?: unknown })?.items) ? (message.params as { items: unknown[] }).items.length : 0 }, () => null)
        : message.method === "workspace/workspaceFolders"
          ? [{ uri: this.options.rootUri, name: "repository" }]
          : null;
      this.send({ jsonrpc: "2.0", id: message.id, result });
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
