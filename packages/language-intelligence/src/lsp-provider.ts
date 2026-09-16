import { accessSync, constants, readFileSync, readdirSync, statSync } from "node:fs";
import { delimiter, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LspClient } from "./lsp-client.ts";
import type {
  CodeLocation,
  DiagnosticResult,
  FileSymbol,
  LanguageIntelligenceOptions,
  LanguageIntelligenceProvider,
  QuickInfoResult,
  SymbolResult,
} from "./index.ts";

type LspPosition = { line: number; character: number };
type LspRange = { start: LspPosition; end: LspPosition };
export type LanguageServerId = "python" | "rust" | "go" | "csharp";

export interface LanguageServerDefinition {
  id: LanguageServerId;
  label: string;
  command: string;
  args: readonly string[];
  envPath: string;
  extensions: readonly string[];
  languageId: string;
}

export interface LanguageProviderStatus {
  id: string;
  label: string;
  available: boolean;
  enabled: boolean;
  command?: string;
  reason?: string;
  extensions: readonly string[];
}

export interface LspProviderOptions extends LanguageIntelligenceOptions {
  definition: LanguageServerDefinition;
  command?: string;
  args?: readonly string[];
  enabled?: boolean;
  timeoutMs?: number;
}

const MAX_SOURCE_BYTES = 1_000_000;
const MAX_RESULTS = 300;
const ignoredDirectories = new Set([
  ".git", ".localcode", ".borg", ".agents", ".codex", ".vinext", ".wrangler",
  "node_modules", "dist", "build", ".next", "coverage",
]);

export const languageServerDefinitions: readonly LanguageServerDefinition[] = [
  {
    id: "python",
    label: "Python (Pyright)",
    command: "pyright-langserver",
    args: ["--stdio"],
    envPath: "BORG_PYRIGHT_LANGSERVER_PATH",
    extensions: [".py", ".pyi"],
    languageId: "python",
  },
  {
    id: "rust",
    label: "Rust (rust-analyzer)",
    command: "rust-analyzer",
    args: [],
    envPath: "BORG_RUST_ANALYZER_PATH",
    extensions: [".rs"],
    languageId: "rust",
  },
  {
    id: "go",
    label: "Go (gopls)",
    command: "gopls",
    args: ["serve"],
    envPath: "BORG_GOPLS_PATH",
    extensions: [".go"],
    languageId: "go",
  },
  {
    id: "csharp",
    label: "C# (csharp-ls)",
    command: "csharp-ls",
    args: [],
    envPath: "BORG_CSHARP_LS_PATH",
    extensions: [".cs"],
    languageId: "csharp",
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function executableExists(command: string): boolean {
  const candidates: string[] = [];
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    candidates.push(command);
  } else {
    const extensions = process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];
    for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
      for (const suffix of extensions) candidates.push(resolve(directory, command + suffix));
    }
  }
  return candidates.some((candidate) => {
    try {
      accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

function configuredProviders(root: string): Partial<Record<LanguageServerId, boolean>> {
  const path = resolve(root, ".localcode", "language-servers.json");
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.providers)) return {};
    const output: Partial<Record<LanguageServerId, boolean>> = {};
    for (const definition of languageServerDefinitions) {
      const entry = parsed.providers[definition.id];
      if (isRecord(entry) && typeof entry.enabled === "boolean") output[definition.id] = entry.enabled;
    }
    return output;
  } catch {
    return {};
  }
}

function symbolKind(value: unknown): string {
  const names = [
    "unknown", "file", "module", "namespace", "package", "class", "method", "property",
    "field", "constructor", "enum", "interface", "function", "variable", "constant",
    "string", "number", "boolean", "array", "object", "key", "null", "enumMember",
    "struct", "event", "operator", "typeParameter",
  ];
  return typeof value === "number" ? (names[value] ?? "unknown") : "unknown";
}

function diagnosticCategory(value: unknown): DiagnosticResult["category"] {
  if (value === 1) return "error";
  if (value === 2) return "warning";
  if (value === 3) return "message";
  return "suggestion";
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textContent).filter(Boolean).join("\n");
  if (isRecord(value) && typeof value.value === "string") return value.value;
  return "";
}

export class LspLanguageIntelligence implements LanguageIntelligenceProvider {
  readonly id: string;
  private readonly root: string;
  private readonly definition: LanguageServerDefinition;
  private readonly options: LspProviderOptions;
  private readonly command: string;
  private readonly args: readonly string[];
  private readonly enabled: boolean;
  private readonly available: boolean;
  private client: LspClient | null = null;

  constructor(root: string, options: LspProviderOptions) {
    this.root = resolve(root);
    this.definition = options.definition;
    this.id = options.definition.id;
    this.options = options;
    this.command = options.command ?? process.env[options.definition.envPath] ?? options.definition.command;
    this.args = options.args ?? options.definition.args;
    this.enabled = options.enabled ?? true;
    this.available = this.enabled && executableExists(this.command);
  }

  status(): LanguageProviderStatus {
    return {
      id: this.id,
      label: this.definition.label,
      available: this.available,
      enabled: this.enabled,
      ...(this.enabled ? { command: this.command } : {}),
      ...(!this.enabled
        ? { reason: "Disabled by .localcode/language-servers.json." }
        : !this.available
          ? { reason: `Language server executable not found: ${this.command}` }
          : {}),
      extensions: this.definition.extensions,
    };
  }

  supports(path: string): boolean {
    return this.definition.extensions.includes(extname(path).toLowerCase());
  }

  hasWorkspaceFiles(): boolean {
    return this.discoverFiles().length > 0;
  }

  async symbols(query: string, limit = 30): Promise<SymbolResult[]> {
    this.assertAvailable();
    const value = query.trim();
    if (!value) return [];
    const raw = await this.getClient().request("workspace/symbol", { query: value });
    if (!Array.isArray(raw)) return [];
    const output: SymbolResult[] = [];
    for (const item of raw.slice(0, Math.min(Math.max(limit, 1), 100))) {
      if (!isRecord(item) || typeof item.name !== "string") continue;
      const location = this.symbolLocation(item);
      if (!location) continue;
      output.push({
        name: item.name,
        kind: symbolKind(item.kind),
        ...(typeof item.containerName === "string" && item.containerName ? { container: item.containerName } : {}),
        ...location,
      });
    }
    return output;
  }

  async fileSymbols(path: string): Promise<FileSymbol[]> {
    const document = await this.open(path);
    const raw = await this.getClient().request("textDocument/documentSymbol", {
      textDocument: { uri: document.uri },
    });
    if (!Array.isArray(raw)) return [];
    const output: FileSymbol[] = [];
    const visit = (items: unknown[], depth: number) => {
      for (const item of items) {
        if (!isRecord(item) || typeof item.name !== "string") continue;
        const range = this.range(item.selectionRange) ?? this.range(item.range);
        const location = range ? this.location(document.uri, range) : this.symbolLocation(item);
        if (location) output.push({ name: item.name, kind: symbolKind(item.kind), depth, ...location });
        if (Array.isArray(item.children) && output.length < MAX_RESULTS) visit(item.children, depth + 1);
        if (output.length >= MAX_RESULTS) return;
      }
    };
    visit(raw, 1);
    return output;
  }

  async definitions(path: string, line: number, column: number): Promise<CodeLocation[]> {
    return this.positionQuery("textDocument/definition", path, line, column);
  }

  async references(path: string, line: number, column: number): Promise<CodeLocation[]> {
    return this.positionQuery("textDocument/references", path, line, column, {
      context: { includeDeclaration: true },
    });
  }

  async implementations(path: string, line: number, column: number): Promise<CodeLocation[]> {
    return this.positionQuery("textDocument/implementation", path, line, column);
  }

  async quickInfo(path: string, line: number, column: number): Promise<QuickInfoResult | null> {
    const document = await this.open(path);
    const raw = await this.getClient().request("textDocument/hover", {
      textDocument: { uri: document.uri },
      position: this.position(line, column),
    });
    if (!isRecord(raw)) return null;
    const range = this.range(raw.range) ?? { start: this.position(line, column), end: this.position(line, column) };
    const location = this.location(document.uri, range);
    if (!location) return null;
    return {
      kind: this.definition.languageId,
      display: textContent(raw.contents),
      documentation: "",
      ...location,
    };
  }

  async diagnostics(path?: string): Promise<DiagnosticResult[]> {
    this.assertAvailable();
    const files = path ? [path] : this.discoverFiles().slice(0, 200);
    const documents = await Promise.all(files.map((file) => this.open(file)));
    await this.getClient().waitForDiagnostics();
    const output: DiagnosticResult[] = [];
    for (const document of documents) {
      for (const value of this.getClient().diagnostics(document.uri)) {
        if (!isRecord(value)) continue;
        const range = this.range(value.range);
        const location = range ? this.location(document.uri, range) : null;
        if (!location || typeof value.message !== "string") continue;
        output.push({
          code: typeof value.code === "number" ? value.code : 0,
          category: diagnosticCategory(value.severity),
          message: value.message,
          ...location,
        });
        if (output.length >= MAX_RESULTS) return output;
      }
    }
    return output;
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
  }

  private assertAvailable(): void {
    if (!this.enabled) throw new Error(`${this.definition.label} language intelligence is disabled.`);
    if (!this.available) throw new Error(`${this.definition.label} language server is unavailable; expected executable: ${this.command}`);
  }

  private getClient(): LspClient {
    this.assertAvailable();
    this.client ??= new LspClient({
      id: this.id,
      command: this.command,
      args: this.args,
      cwd: this.root,
      rootUri: pathToFileURL(this.root).href,
      timeoutMs: this.options.timeoutMs,
    });
    return this.client;
  }

  private async open(path: string): Promise<{ uri: string; path: string }> {
    this.assertAvailable();
    const absolute = this.absolute(path);
    const info = statSync(absolute);
    if (!info.isFile()) throw new Error(`Not a regular file: ${path}`);
    if (info.size > MAX_SOURCE_BYTES) throw new Error(`Language intelligence source exceeds ${MAX_SOURCE_BYTES} bytes: ${path}`);
    const uri = pathToFileURL(absolute).href;
    await this.getClient().openDocument(uri, this.definition.languageId, readFileSync(absolute, "utf8"));
    return { uri, path: absolute };
  }

  private async positionQuery(
    method: string,
    path: string,
    line: number,
    column: number,
    extra: Record<string, unknown> = {},
  ): Promise<CodeLocation[]> {
    const document = await this.open(path);
    const raw = await this.getClient().request(method, {
      textDocument: { uri: document.uri },
      position: this.position(line, column),
      ...extra,
    });
    const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return values.map((value) => this.locationValue(value)).filter((value): value is CodeLocation => value !== null).slice(0, MAX_RESULTS);
  }

  private position(line: number, column: number): LspPosition {
    if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1) {
      throw new Error("line and column are 1-based positive integers");
    }
    return { line: line - 1, character: column - 1 };
  }

  private range(value: unknown): LspRange | null {
    if (!isRecord(value) || !isRecord(value.start) || !isRecord(value.end)) return null;
    const start = value.start;
    const end = value.end;
    if (![start.line, start.character, end.line, end.character].every((item) => typeof item === "number" && Number.isInteger(item) && item >= 0)) return null;
    return {
      start: { line: start.line as number, character: start.character as number },
      end: { line: end.line as number, character: end.character as number },
    };
  }

  private locationValue(value: unknown): CodeLocation | null {
    if (!isRecord(value)) return null;
    const uri = typeof value.uri === "string" ? value.uri : typeof value.targetUri === "string" ? value.targetUri : null;
    const range = this.range(value.range) ?? this.range(value.targetSelectionRange) ?? this.range(value.targetRange);
    return uri && range ? this.location(uri, range) : null;
  }

  private symbolLocation(value: Record<string, unknown>): CodeLocation | null {
    if (isRecord(value.location)) return this.locationValue(value.location);
    const uri = typeof value.uri === "string" ? value.uri : null;
    const range = this.range(value.range) ?? this.range(value.selectionRange);
    return uri && range ? this.location(uri, range) : null;
  }

  private location(uri: string, range: LspRange): CodeLocation | null {
    if (!uri.startsWith("file:")) return null;
    let absolute: string;
    try {
      absolute = resolve(fileURLToPath(uri));
    } catch {
      return null;
    }
    const rel = relative(this.root, absolute);
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    const path = rel.replaceAll("\\", "/");
    if (this.options.allowPath && !this.options.allowPath(path)) return null;
    return {
      path,
      line: range.start.line + 1,
      column: range.start.character + 1,
      endLine: range.end.line + 1,
      endColumn: range.end.character + 1,
    };
  }

  private absolute(path: string): string {
    const absolute = resolve(this.root, path);
    const rel = relative(this.root, absolute);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Path escapes workspace root: ${path}`);
    if (!this.supports(absolute)) throw new Error(`${this.definition.label} does not support this file: ${path}`);
    const display = rel.replaceAll("\\", "/");
    if (this.options.allowPath && !this.options.allowPath(display)) throw new Error(`Language intelligence access is not allowed for this file: ${path}`);
    return absolute;
  }

  private discoverFiles(): string[] {
    const output: string[] = [];
    const visit = (directory: string) => {
      if (output.length >= 200) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || ignoredDirectories.has(entry.name)) continue;
        const absolute = resolve(directory, entry.name);
        if (entry.isDirectory()) visit(absolute);
        else if (entry.isFile() && this.supports(entry.name)) {
          const rel = relative(this.root, absolute).replaceAll("\\", "/");
          if (!this.options.allowPath || this.options.allowPath(rel)) output.push(rel);
        }
        if (output.length >= 200) return;
      }
    };
    visit(this.root);
    return output;
  }
}

export function createLspProviders(root: string, options: LanguageIntelligenceOptions = {}): LspLanguageIntelligence[] {
  const configured = configuredProviders(root);
  return languageServerDefinitions.map((definition) => new LspLanguageIntelligence(root, {
    ...options,
    definition,
    enabled: configured[definition.id] ?? true,
  }));
}
