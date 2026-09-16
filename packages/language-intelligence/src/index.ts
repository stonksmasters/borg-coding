import { statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import ts from "typescript";
import { createLspProviders, type LanguageProviderStatus, type LspLanguageIntelligence } from "./lsp-provider.ts";

export interface CodeLocation {
  path: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

export interface SymbolResult extends CodeLocation {
  name: string;
  kind: string;
  container?: string;
}

export interface FileSymbol extends SymbolResult {
  depth: number;
}

export interface DiagnosticResult extends CodeLocation {
  category: "error" | "warning" | "suggestion" | "message";
  code: number;
  message: string;
}

export interface QuickInfoResult extends CodeLocation {
  kind: string;
  display: string;
  documentation: string;
}

export interface LanguageIntelligenceProvider {
  readonly id: string;
  supports(path: string): boolean;
  symbols(query: string, limit?: number): Promise<SymbolResult[]>;
  fileSymbols(path: string): Promise<FileSymbol[]>;
  definitions(path: string, line: number, column: number): Promise<CodeLocation[]>;
  references(path: string, line: number, column: number): Promise<CodeLocation[]>;
  implementations(path: string, line: number, column: number): Promise<CodeLocation[]>;
  diagnostics(path?: string): Promise<DiagnosticResult[]>;
  quickInfo(path: string, line: number, column: number): Promise<QuickInfoResult | null>;
}

export interface LanguageIntelligenceOptions {
  allowPath?: (relativePath: string) => boolean;
}

export interface LanguageIntelligenceService extends LanguageIntelligenceProvider {
  status(): LanguageProviderStatus[];
  close(): Promise<void>;
}

const supportedExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
const excludedDirectories = ["**/node_modules/**", "**/.git/**", "**/.localcode/**", "**/.borg/**", "**/.agents/**", "**/.codex/**", "**/.vinext/**", "**/.wrangler/**", "**/dist/**", "**/build/**", "**/.next/**", "**/coverage/**"];

function extension(path: string): string {
  const match = path.toLowerCase().match(/\.[^.\\/]+$/);
  return match?.[0] ?? "";
}

function category(value: ts.DiagnosticCategory): DiagnosticResult["category"] {
  if (value === ts.DiagnosticCategory.Error) return "error";
  if (value === ts.DiagnosticCategory.Warning) return "warning";
  if (value === ts.DiagnosticCategory.Suggestion) return "suggestion";
  return "message";
}

export class TypeScriptLanguageIntelligence implements LanguageIntelligenceProvider {
  readonly id = "typescript";
  readonly root: string;
  private readonly service: ts.LanguageService;
  private readonly compilerOptions: ts.CompilerOptions;
  private readonly options: LanguageIntelligenceOptions;
  private fileNames: string[] = [];
  private projectVersion = 0;

  constructor(root: string, options: LanguageIntelligenceOptions = {}) {
    this.root = resolve(root);
    this.options = options;
    this.compilerOptions = this.loadCompilerOptions();
    this.refreshFiles();

    const host: ts.LanguageServiceHost = {
      getCompilationSettings: () => this.compilerOptions,
      getCurrentDirectory: () => this.root,
      getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
      getProjectVersion: () => String(this.projectVersion),
      getScriptFileNames: () => this.fileNames,
      getScriptVersion: (fileName) => {
        if (!this.canReadHostFile(fileName)) return "0";
        try {
          const info = statSync(fileName);
          return `${info.mtimeMs}:${info.size}`;
        } catch {
          return "0";
        }
      },
      getScriptSnapshot: (fileName) => {
        if (!this.canReadHostFile(fileName)) return undefined;
        const text = ts.sys.readFile(fileName);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      fileExists: (fileName) => this.canReadHostFile(fileName) && ts.sys.fileExists(fileName),
      readFile: (fileName) => this.canReadHostFile(fileName) ? ts.sys.readFile(fileName) : undefined,
      readDirectory: (path, extensions, exclude, include, depth) => ts.sys.readDirectory(path, extensions, exclude, include, depth).filter((fileName) => this.canReadHostFile(fileName)),
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames
    };

    this.service = ts.createLanguageService(host, ts.createDocumentRegistry());
  }

  supports(path: string): boolean {
    return supportedExtensions.has(extension(path));
  }

  async symbols(query: string, limit = 30): Promise<SymbolResult[]> {
    this.refreshFiles();
    const value = query.trim();
    if (!value) return [];
    const items = this.service.getNavigateToItems(value, Math.max(1, Math.min(limit, 100)), undefined, true);
    return items
      .filter((item) => this.isWorkspaceFile(item.fileName))
      .map((item) => ({
        name: item.name,
        kind: item.kind,
        container: item.containerName || undefined,
        ...this.location(item.fileName, item.textSpan)
      }));
  }

  async fileSymbols(path: string): Promise<FileSymbol[]> {
    this.refreshFiles();
    const fileName = this.absolute(path);
    const tree = this.service.getNavigationTree(fileName);
    const results: FileSymbol[] = [];
    const visit = (node: ts.NavigationTree, depth: number) => {
      if (depth > 0) {
        results.push({
          name: node.text,
          kind: node.kind,
          depth,
          ...this.location(fileName, node.spans[0] ?? { start: 0, length: 0 })
        });
      }
      for (const child of node.childItems ?? []) visit(child, depth + 1);
    };
    visit(tree, 0);
    return results.slice(0, 300);
  }

  async definitions(path: string, line: number, column: number): Promise<CodeLocation[]> {
    return this.positionQuery(path, line, column, (fileName, offset) => this.service.getDefinitionAtPosition(fileName, offset));
  }

  async references(path: string, line: number, column: number): Promise<CodeLocation[]> {
    return this.positionQuery(path, line, column, (fileName, offset) => this.service.getReferencesAtPosition(fileName, offset));
  }

  async implementations(path: string, line: number, column: number): Promise<CodeLocation[]> {
    return this.positionQuery(path, line, column, (fileName, offset) => this.service.getImplementationAtPosition(fileName, offset));
  }

  async quickInfo(path: string, line: number, column: number): Promise<QuickInfoResult | null> {
    this.refreshFiles();
    const fileName = this.absolute(path);
    const offset = this.offset(fileName, line, column);
    const info = this.service.getQuickInfoAtPosition(fileName, offset);
    if (!info) return null;
    return {
      kind: info.kind,
      display: ts.displayPartsToString(info.displayParts),
      documentation: ts.displayPartsToString(info.documentation),
      ...this.location(fileName, info.textSpan)
    };
  }

  async diagnostics(path?: string): Promise<DiagnosticResult[]> {
    this.refreshFiles();
    const files = path ? [this.absolute(path)] : this.fileNames.filter((file) => !file.endsWith(".d.ts")).slice(0, 200);
    const output: DiagnosticResult[] = [];

    for (const fileName of files) {
      if (!this.isWorkspaceFile(fileName) || !this.supports(fileName)) continue;
      const diagnostics = [
        ...this.service.getSyntacticDiagnostics(fileName),
        ...this.service.getSemanticDiagnostics(fileName),
        ...this.safeSuggestionDiagnostics(fileName)
      ];
      const seen = new Set<string>();
      for (const diagnostic of diagnostics) {
        if (!diagnostic.file || diagnostic.start === undefined || !this.isWorkspaceFile(diagnostic.file.fileName)) continue;
        const key = `${diagnostic.code}:${diagnostic.start}:${diagnostic.length ?? 0}`;
        if (seen.has(key)) continue;
        seen.add(key);
        output.push({
          code: diagnostic.code,
          category: category(diagnostic.category),
          message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
          ...this.location(diagnostic.file.fileName, { start: diagnostic.start, length: diagnostic.length ?? 0 })
        });
        if (output.length >= 300) return output;
      }
    }
    return output;
  }

  private safeSuggestionDiagnostics(fileName: string): readonly ts.Diagnostic[] {
    try {
      return this.service.getSuggestionDiagnostics(fileName);
    } catch {
      return [];
    }
  }

  private async positionQuery<T extends { fileName: string; textSpan: ts.TextSpan }>(
    path: string,
    line: number,
    column: number,
    query: (fileName: string, offset: number) => readonly T[] | undefined
  ): Promise<CodeLocation[]> {
    this.refreshFiles();
    const fileName = this.absolute(path);
    const offset = this.offset(fileName, line, column);
    return (query(fileName, offset) ?? [])
      .filter((item) => this.isWorkspaceFile(item.fileName))
      .map((item) => this.location(item.fileName, item.textSpan));
  }

  private offset(fileName: string, line: number, column: number): number {
    if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1) throw new Error("line and column are 1-based positive integers");
    const source = this.sourceFile(fileName);
    const lineIndex = line - 1;
    const columnIndex = column - 1;
    if (lineIndex >= source.getLineStarts().length) throw new Error(`Line ${line} is outside ${this.displayPath(fileName)}`);
    return source.getPositionOfLineAndCharacter(lineIndex, columnIndex);
  }

  private location(fileName: string, span: ts.TextSpan): CodeLocation {
    const source = this.sourceFile(fileName);
    const start = source.getLineAndCharacterOfPosition(Math.min(span.start, source.getFullText().length));
    const endOffset = Math.min(span.start + span.length, source.getFullText().length);
    const end = source.getLineAndCharacterOfPosition(endOffset);
    return {
      path: this.displayPath(fileName),
      line: start.line + 1,
      column: start.character + 1,
      endLine: end.line + 1,
      endColumn: end.character + 1
    };
  }

  private sourceFile(fileName: string): ts.SourceFile {
    const absolute = resolve(fileName);
    const program = this.service.getProgram();
    const existing = program?.getSourceFile(absolute) ?? program?.getSourceFile(absolute.replaceAll("\\", "/"));
    if (existing) return existing;
    if (!this.canReadHostFile(absolute)) throw new Error(`Language intelligence access is not allowed for this file: ${this.displayPath(absolute)}`);
    const text = ts.sys.readFile(absolute);
    if (text === undefined) throw new Error(`File not found: ${this.displayPath(absolute)}`);
    return ts.createSourceFile(absolute, text, this.compilerOptions.target ?? ts.ScriptTarget.ES2022, true);
  }

  private absolute(path: string): string {
    const fileName = resolve(this.root, path);
    const rel = relative(this.root, fileName);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Path escapes workspace root: ${path}`);
    if (!this.supports(fileName)) throw new Error(`Language intelligence does not support this file: ${path}`);
    if (!this.isAllowed(fileName)) throw new Error(`Language intelligence access is not allowed for this file: ${path}`);
    return fileName;
  }

  private displayPath(fileName: string): string {
    const rel = relative(this.root, resolve(fileName));
    return rel.startsWith("..") || isAbsolute(rel) ? resolve(fileName) : rel.replaceAll("\\", "/");
  }

  private isAllowed(fileName: string): boolean {
    const rel = relative(this.root, resolve(fileName));
    if (rel.startsWith("..") || isAbsolute(rel)) return false;
    const display = rel.replaceAll("\\", "/");
    return this.options.allowPath ? this.options.allowPath(display) : true;
  }

  private canReadHostFile(fileName: string): boolean {
    const rel = relative(this.root, resolve(fileName));
    if (rel.startsWith("..") || isAbsolute(rel)) return true;
    if (rel.split(/[\\/]/).includes("node_modules")) return true;
    return this.isAllowed(fileName);
  }

  private isWorkspaceFile(fileName: string): boolean {
    const rel = relative(this.root, resolve(fileName));
    return !rel.startsWith("..") && !isAbsolute(rel) && !rel.split(/[\\/]/).includes("node_modules") && !rel.startsWith(".localcode") && this.isAllowed(fileName);
  }

  private refreshFiles(): void {
    const next = ts.sys.readDirectory(
      this.root,
      [...supportedExtensions],
      excludedDirectories,
      ["**/*"],
      20
    ).map((file) => resolve(file)).filter((file) => this.isAllowed(file)).sort();
    if (next.length === this.fileNames.length && next.every((file, index) => file === this.fileNames[index])) return;
    this.fileNames = next;
    this.projectVersion += 1;
  }

  private loadCompilerOptions(): ts.CompilerOptions {
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const configPath = resolve(this.root, name);
      if (!ts.sys.fileExists(configPath)) continue;
      const read = ts.readConfigFile(configPath, ts.sys.readFile);
      if (!read.error) {
        const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath));
        return { ...parsed.options, noEmit: true, allowJs: parsed.options.allowJs ?? true };
      }
    }
    return {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.Preserve,
      allowJs: true,
      checkJs: false,
      skipLibCheck: true,
      noEmit: true
    };
  }
}

export class PolyglotLanguageIntelligence implements LanguageIntelligenceService {
  readonly id = "polyglot";
  private readonly typescript: TypeScriptLanguageIntelligence;
  private readonly lsp: LspLanguageIntelligence[];

  constructor(root: string, options: LanguageIntelligenceOptions = {}, providers?: LspLanguageIntelligence[]) {
    this.typescript = new TypeScriptLanguageIntelligence(root, options);
    this.lsp = providers ?? createLspProviders(root, options);
  }

  supports(path: string): boolean {
    return this.providers().some((provider) => provider.supports(path));
  }

  status(): LanguageProviderStatus[] {
    return [
      {
        id: this.typescript.id,
        label: "TypeScript / JavaScript",
        available: true,
        enabled: true,
        command: "built-in TypeScript Language Service",
        extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
      },
      ...this.lsp.map((provider) => provider.status()),
    ];
  }

  async symbols(query: string, limit = 30): Promise<SymbolResult[]> {
    const providers = [
      this.typescript,
      ...this.lsp.filter((provider) => provider.status().available),
    ];
    const results = await Promise.all(providers.map((provider) => provider.symbols(query, limit)));
    return results.flat().slice(0, Math.max(1, Math.min(limit, 100)));
  }

  async fileSymbols(path: string): Promise<FileSymbol[]> {
    return this.forPath(path).fileSymbols(path);
  }

  async definitions(path: string, line: number, column: number): Promise<CodeLocation[]> {
    return this.forPath(path).definitions(path, line, column);
  }

  async references(path: string, line: number, column: number): Promise<CodeLocation[]> {
    return this.forPath(path).references(path, line, column);
  }

  async implementations(path: string, line: number, column: number): Promise<CodeLocation[]> {
    return this.forPath(path).implementations(path, line, column);
  }

  async quickInfo(path: string, line: number, column: number): Promise<QuickInfoResult | null> {
    return this.forPath(path).quickInfo(path, line, column);
  }

  async diagnostics(path?: string): Promise<DiagnosticResult[]> {
    if (path) return this.forPath(path).diagnostics(path);
    const providers = [
      this.typescript,
      ...this.lsp.filter((provider) => provider.status().available),
    ];
    const results = await Promise.all(providers.map((provider) => provider.diagnostics()));
    return results.flat().slice(0, 300);
  }

  async close(): Promise<void> {
    await Promise.all(this.lsp.map((provider) => provider.close()));
  }

  private providers(): LanguageIntelligenceProvider[] {
    return [this.typescript, ...this.lsp];
  }

  private forPath(path: string): LanguageIntelligenceProvider {
    const provider = this.providers().find((candidate) => candidate.supports(path));
    if (!provider) throw new Error(`Language intelligence does not support this file: ${path}`);
    return provider;
  }
}

export function createLanguageIntelligence(root: string, options: LanguageIntelligenceOptions = {}): LanguageIntelligenceService {
  return new PolyglotLanguageIntelligence(root, options);
}
