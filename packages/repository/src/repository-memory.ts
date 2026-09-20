import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";
import type { LanguageIntelligenceService } from "../../language-intelligence/src/index.ts";
import type { AccessController } from "./access-controller.ts";

const typescriptExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
const sourceExtensions = new Set([...typescriptExtensions, ".py", ".pyi", ".rs", ".go", ".cs"]);
const maxFiles = 500;
const maxBytes = 500_000;

export interface MemoryNote {
  id: string;
  kind: "finding" | "decision";
  text: string;
  taskId: string;
  path: string | null;
  line: number | null;
  createdAt: string;
}

export class RepositoryMemory {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS memory_files (
        root TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT NOT NULL, indexed_at TEXT NOT NULL,
        PRIMARY KEY (root, path)
      );
      CREATE TABLE IF NOT EXISTS memory_symbols (
        root TEXT NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
        line INTEGER NOT NULL, column INTEGER NOT NULL,
        FOREIGN KEY (root, path) REFERENCES memory_files(root, path) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS memory_imports (
        root TEXT NOT NULL, source_path TEXT NOT NULL, target_path TEXT NOT NULL,
        FOREIGN KEY (root, source_path) REFERENCES memory_files(root, path) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS memory_notes (
        root TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
        task_id TEXT NOT NULL, path TEXT, line INTEGER, created_at TEXT NOT NULL,
        PRIMARY KEY (root, id)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_symbols ON memory_symbols(root, name);
      CREATE INDEX IF NOT EXISTS idx_memory_imports_target ON memory_imports(root, target_path);
      CREATE INDEX IF NOT EXISTS idx_memory_notes_task ON memory_notes(root, task_id);
    `);
  }

  async refresh(access: AccessController, language: LanguageIntelligenceService): Promise<{ scanned: number; updated: number; removed: number; truncated: boolean }> {
    const root = realpathSync(access.repositoryRootPath());
    const paths: string[] = [];
    let truncated = false;
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (paths.length >= maxFiles) { truncated = true; return; }
        if (entry.isSymbolicLink()) continue;
        const absolute = resolve(directory, entry.name);
        const path = relative(root, absolute).replaceAll("\\", "/");
        if (entry.isDirectory()) {
          if ([".git", ".agents", ".codex", ".localcode", ".borg", "node_modules", "dist", "build", ".next", ".vinext", ".wrangler", "coverage"].includes(entry.name)) continue;
          walk(absolute);
        } else if (entry.isFile() && sourceExtensions.has(extname(entry.name).toLowerCase()) && statSync(absolute).size <= maxBytes && access.allowsRepositoryFile(path)) {
          paths.push(path);
        }
      }
    };
    walk(root);
    paths.sort();
    const existing = new Map((this.database.prepare("SELECT path, sha256 FROM memory_files WHERE root = ?").all(root) as { path: string; sha256: string }[]).map((row) => [row.path, row.sha256]));
    const configPath = resolve(root, "tsconfig.json");
    const configuration = ts.sys.fileExists(configPath) ? ts.readConfigFile(configPath, ts.sys.readFile) : null;
    const compilerOptions = configuration && !configuration.error
      ? ts.parseJsonConfigFileContent(configuration.config, ts.sys, root).options
      : { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext };
    let updated = 0;
    for (const path of paths) {
      const content = readFileSync(resolve(root, path));
      const sha256 = createHash("sha256").update(content).digest("hex");
      if (existing.get(path) === sha256) continue;
      const provider = language.status().find((item) => item.extensions.includes(extname(path).toLowerCase()));
      const symbols = provider?.available ? await language.fileSymbols(path) : [];
      const imports = new Set<string>();
      if (typescriptExtensions.has(extname(path).toLowerCase())) {
        const source = ts.createSourceFile(path, content.toString("utf8"), ts.ScriptTarget.Latest, true);
        for (const statement of source.statements) {
          const specifier = (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) ? statement.moduleSpecifier : undefined;
          if (!specifier || !ts.isStringLiteral(specifier)) continue;
          const resolved = ts.resolveModuleName(specifier.text, resolve(root, path), compilerOptions, ts.sys).resolvedModule?.resolvedFileName;
          if (!resolved) continue;
          const target = relative(root, resolve(resolved)).replaceAll("\\", "/");
          if (!target.startsWith("..") && access.allowsRepositoryFile(target)) imports.add(target);
        }
      } else {
        const graph = await language.fileGraph(path);
        for (const target of graph.imports) if (access.allowsRepositoryFile(target)) imports.add(target);
      }
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.prepare("INSERT INTO memory_files (root, path, sha256, indexed_at) VALUES (?, ?, ?, ?) ON CONFLICT(root, path) DO UPDATE SET sha256=excluded.sha256, indexed_at=excluded.indexed_at").run(root, path, sha256, new Date().toISOString());
        this.database.prepare("DELETE FROM memory_symbols WHERE root = ? AND path = ?").run(root, path);
        this.database.prepare("DELETE FROM memory_imports WHERE root = ? AND source_path = ?").run(root, path);
        const insertSymbol = this.database.prepare("INSERT INTO memory_symbols (root, path, name, kind, line, column) VALUES (?, ?, ?, ?, ?, ?)");
        for (const symbol of symbols.slice(0, 300)) insertSymbol.run(root, path, symbol.name.slice(0, 300), symbol.kind, symbol.line, symbol.column);
        const insertImport = this.database.prepare("INSERT INTO memory_imports (root, source_path, target_path) VALUES (?, ?, ?)");
        for (const imported of imports) insertImport.run(root, path, imported);
        this.database.exec("COMMIT");
        updated += 1;
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    let removed = 0;
    if (!truncated) {
      const current = new Set(paths);
      for (const path of existing.keys()) if (!current.has(path)) {
        this.database.prepare("DELETE FROM memory_files WHERE root = ? AND path = ?").run(root, path);
        removed += 1;
      }
    }
    return { scanned: paths.length, updated, removed, truncated };
  }

  recordNote(rootPath: string, note: MemoryNote): void {
    const root = realpathSync(rootPath);
    this.database.prepare("INSERT INTO memory_notes (root, id, kind, text, task_id, path, line, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(root, id) DO UPDATE SET text=excluded.text, path=excluded.path, line=excluded.line")
      .run(root, note.id, note.kind, note.text.slice(0, 2000), note.taskId, note.path, note.line, note.createdAt);
  }

  search(rootPath: string, query: string, limit = 20, allowPath: (path: string) => boolean = () => true) {
    const root = realpathSync(rootPath);
    const needle = query.trim().slice(0, 200).toLowerCase();
    const count = Math.max(1, Math.min(50, Math.floor(limit)));
    const pattern = `%${needle.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    const symbols = this.database.prepare("SELECT s.path, s.name, s.kind, s.line, s.column, f.indexed_at AS indexedAt FROM memory_symbols s JOIN memory_files f ON f.root=s.root AND f.path=s.path WHERE s.root=? AND (lower(s.name) LIKE ? ESCAPE '\\' OR lower(s.path) LIKE ? ESCAPE '\\') ORDER BY s.name LIMIT ?")
      .all(root, pattern, pattern, count);
    const imports = this.database.prepare("SELECT source_path AS source, target_path AS target FROM memory_imports WHERE root=? AND (lower(source_path) LIKE ? ESCAPE '\\' OR lower(target_path) LIKE ? ESCAPE '\\') ORDER BY source_path LIMIT ?")
      .all(root, pattern, pattern, count);
    const notes = this.database.prepare("SELECT id, kind, text, task_id AS taskId, path, line, created_at AS createdAt FROM memory_notes WHERE root=? AND (lower(text) LIKE ? ESCAPE '\\' OR lower(coalesce(path,'')) LIKE ? ESCAPE '\\') ORDER BY created_at DESC LIMIT ?")
      .all(root, pattern, pattern, count);
    return {
      query: query.trim(),
      symbols: (symbols as { path: string }[]).filter((item) => allowPath(item.path)),
      imports: (imports as { source: string; target: string }[]).filter((item) => allowPath(item.source) && allowPath(item.target)),
      notes: (notes as { id: string; kind: string; text: string; taskId: string; path: string | null; line: number | null; createdAt: string }[]).filter((item) => !item.path || allowPath(item.path)),
    };
  }

  relatedPaths(rootPath: string, request: string, limit = 12, allowPath: (path: string) => boolean = () => true): string[] {
    const terms = [...new Set(request.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? [])].slice(0, 12);
    const scores = new Map<string, number>();
    const add = (path: string, score: number) => {
      if (!path || !allowPath(path)) return;
      scores.set(path, (scores.get(path) ?? 0) + score);
    };
    for (const term of terms) {
      const result = this.search(rootPath, term, Math.max(3, Math.min(12, limit)), allowPath);
      for (const item of result.symbols as { path: string }[]) add(item.path, 4);
      for (const item of result.imports as { source: string; target: string }[]) {
        add(item.source, 2);
        add(item.target, 3);
      }
      for (const item of result.notes) if (item.path) add(item.path, 1);
    }
    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, Math.max(1, Math.min(30, Math.floor(limit))))
      .map(([path]) => path);
  }

  context(rootPath: string, request: string, allowPath: (path: string) => boolean = () => true): string {
    const terms = [...new Set(request.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? [])].slice(0, 8);
    const sections = terms.flatMap((term) => {
      const result = this.search(rootPath, term, 3, allowPath);
      return [
        ...(result.symbols as { path: string; name: string; line: number }[]).map((item) => `symbol ${item.name} at ${item.path}:${item.line}`),
        ...result.notes.map((item) => `${item.kind} from task ${item.taskId}: ${item.text}`),
      ];
    });
    return [...new Set(sections)].slice(0, 15).join("\n").slice(0, 3000);
  }

  close(): void { this.database.close(); }
}
