import { existsSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";

export interface AccessPolicy {
  repositoryPath: string | null;
  documents: string[];
  updatedAt: string;
}

const ignoredDirectories = new Set([".git", ".agents", ".codex", "node_modules", "dist", "build", ".next", ".vinext", ".wrangler", "coverage", ".borg"]);
const importantNames = new Set(["agents.md", "readme.md", "readme.txt", "package.json", "tsconfig.json", "cargo.toml", "go.mod", "pyproject.toml", "requirements.txt", "dockerfile", "docker-compose.yml", "docker-compose.yaml"]);
const textExtensions = new Set([".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".cs", ".sql", ".html", ".css", ".scss", ".xml", ".csv"]);
const sensitiveName = /(^\.env($|\.)|secret|credential|id_rsa|id_ed25519|\.pem$|\.key$|\.pfx$)/i;

export interface RepositoryFileMatch { path: string; line: number; text: string; }

function emptyPolicy(): AccessPolicy { return { repositoryPath: null, documents: [], updatedAt: new Date().toISOString() }; }

export class AccessController {
  private readonly policyPath: string;

  constructor(policyPath: string) { this.policyPath = policyPath; }

  load(): AccessPolicy {
    if (!existsSync(this.policyPath)) return emptyPolicy();
    try {
      const value = JSON.parse(readFileSync(this.policyPath, "utf8")) as AccessPolicy;
      return { repositoryPath: value.repositoryPath ?? null, documents: Array.isArray(value.documents) ? value.documents : [], updatedAt: value.updatedAt ?? new Date().toISOString() };
    } catch { return emptyPolicy(); }
  }

  save(input: { repositoryPath?: unknown; documents?: unknown }): AccessPolicy {
    const rawRepository = String(input.repositoryPath ?? "").trim();
    let repositoryPath: string | null = null;
    if (rawRepository) {
      if (!isAbsolute(rawRepository)) throw new Error("Repository path must be an absolute path.");
      repositoryPath = resolve(rawRepository);
      if (!existsSync(repositoryPath) || !statSync(repositoryPath).isDirectory()) throw new Error("Repository folder does not exist or is not a directory.");
    }

    const rawDocuments = Array.isArray(input.documents) ? input.documents : [];
    const documents = [...new Set(rawDocuments.map((item) => String(item).trim()).filter(Boolean).map((item) => resolve(item)))];
    for (const documentPath of documents) {
      if (!isAbsolute(documentPath) || !existsSync(documentPath) || !statSync(documentPath).isFile()) throw new Error(`Document does not exist: ${documentPath}`);
      if (sensitiveName.test(basename(documentPath))) throw new Error(`Sensitive file types cannot be granted: ${basename(documentPath)}`);
      if (!textExtensions.has(extname(documentPath).toLowerCase())) throw new Error(`Only text and source documents are supported right now: ${basename(documentPath)}`);
    }

    const policy = { repositoryPath, documents, updatedAt: new Date().toISOString() };
    const temporaryPath = `${this.policyPath}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(policy, null, 2), "utf8");
    renameSync(temporaryPath, this.policyPath);
    return policy;
  }

  describe(policy = this.load()) {
    return { ...policy, repositoryName: policy.repositoryPath ? basename(policy.repositoryPath) : null, documentNames: policy.documents.map((path) => basename(path)) };
  }

  repositoryRootPath(): string {
    return this.repositoryRoot();
  }

  allowsRepositoryFile(relativePath: string): boolean {
    try {
      const file = this.approvedPath(relativePath, true);
      return textExtensions.has(extname(file.absolute).toLowerCase()) || importantNames.has(basename(file.absolute).toLowerCase());
    } catch {
      return false;
    }
  }

  private repositoryRoot(): string {
    const repositoryPath = this.load().repositoryPath;
    if (!repositoryPath) throw new Error("No repository has been approved.");
    return realpathSync(repositoryPath);
  }

  private approvedPath(relativePath = ".", requireFile = false): { root: string; absolute: string; relativePath: string } {
    if (isAbsolute(relativePath)) throw new Error("Repository tool paths must be relative.");
    const root = this.repositoryRoot();
    const candidate = resolve(root, relativePath || ".");
    const fromRoot = relative(root, candidate);
    if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) throw new Error("Path is outside the approved repository.");
    if (!existsSync(candidate)) throw new Error(`Repository path does not exist: ${relativePath}`);
    const absolute = realpathSync(candidate);
    const realFromRoot = relative(root, absolute);
    if (realFromRoot.startsWith("..") || isAbsolute(realFromRoot)) throw new Error("Symbolic link leaves the approved repository.");
    const parts = realFromRoot.split(/[\\/]/).filter(Boolean);
    if (parts.some((part) => ignoredDirectories.has(part) || sensitiveName.test(part))) throw new Error("This path is excluded by the repository access policy.");
    if (requireFile && !statSync(absolute).isFile()) throw new Error("Path must identify a file.");
    return { root, absolute, relativePath: realFromRoot.replaceAll("\\", "/") || "." };
  }

  listFiles(input: { path?: string; depth?: number; maxEntries?: number } = {}) {
    const start = this.approvedPath(input.path ?? ".");
    if (!statSync(start.absolute).isDirectory()) throw new Error("Path must identify a directory.");
    const maxDepth = Math.max(0, Math.min(6, Math.floor(input.depth ?? 2)));
    const maxEntries = Math.max(1, Math.min(1000, Math.floor(input.maxEntries ?? 300)));
    const entries: { path: string; type: "file" | "directory" }[] = [];
    const walk = (directory: string, depth: number) => {
      if (depth > maxDepth || entries.length >= maxEntries) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entries.length >= maxEntries || sensitiveName.test(entry.name) || ignoredDirectories.has(entry.name) || entry.isSymbolicLink()) continue;
        const absolute = join(directory, entry.name);
        const path = relative(start.root, absolute).replaceAll("\\", "/");
        if (entry.isDirectory()) { entries.push({ path, type: "directory" }); walk(absolute, depth + 1); }
        else if (entry.isFile()) entries.push({ path, type: "file" });
      }
    };
    walk(start.absolute, 0);
    return { root: basename(start.root), path: start.relativePath, entries, truncated: entries.length >= maxEntries };
  }

  readFile(relativePath: string, maxCharacters = 60_000) {
    const file = this.approvedPath(relativePath, true);
    if (!textExtensions.has(extname(file.absolute).toLowerCase()) && !importantNames.has(basename(file.absolute).toLowerCase())) throw new Error("Only text and source files may be read.");
    const size = statSync(file.absolute).size;
    if (size > 1_000_000) throw new Error("File is too large to read safely.");
    const content = readFileSync(file.absolute, "utf8").slice(0, Math.max(1, Math.min(100_000, maxCharacters)));
    return { path: file.relativePath, content, truncated: content.length < size };
  }

  searchFiles(query: string, input: { path?: string; maxResults?: number } = {}) {
    const needle = query.trim().toLowerCase();
    if (!needle) throw new Error("Search query is required.");
    if (needle.length > 300) throw new Error("Search query is too long.");
    const start = this.approvedPath(input.path ?? ".");
    if (!statSync(start.absolute).isDirectory()) throw new Error("Search path must identify a directory.");
    const limit = Math.max(1, Math.min(200, Math.floor(input.maxResults ?? 50)));
    const matches: RepositoryFileMatch[] = [];
    let scannedFiles = 0;
    const walk = (directory: string) => {
      if (matches.length >= limit || scannedFiles >= 2000) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (matches.length >= limit || scannedFiles >= 2000 || sensitiveName.test(entry.name) || ignoredDirectories.has(entry.name) || entry.isSymbolicLink()) continue;
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) { walk(absolute); continue; }
        if (!entry.isFile() || !textExtensions.has(extname(entry.name).toLowerCase())) continue;
        const size = statSync(absolute).size;
        if (size > 500_000) continue;
        scannedFiles += 1;
        const lines = readFileSync(absolute, "utf8").split(/\r?\n/);
        for (let index = 0; index < lines.length && matches.length < limit; index += 1) {
          if (lines[index].toLowerCase().includes(needle)) matches.push({ path: relative(start.root, absolute).replaceAll("\\", "/"), line: index + 1, text: lines[index].slice(0, 500) });
        }
      }
    };
    walk(start.absolute);
    return { query: query.trim(), path: start.relativePath, matches, scannedFiles, truncated: matches.length >= limit || scannedFiles >= 2000 };
  }

  buildContext(maxCharacters = 80_000): string {
    const policy = this.load();
    if (!policy.repositoryPath && policy.documents.length === 0) return "ACCESS SCOPE: No repository or documents have been approved. Ask the user to configure access in the BORG sidebar.";
    const sections: string[] = ["ACCESS SCOPE (read-only):"];

    if (policy.repositoryPath) {
      const tree: string[] = [];
      const important: string[] = [];
      const walk = (directory: string, depth: number) => {
        if (depth > 4 || tree.length >= 600) return;
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          if (tree.length >= 600 || sensitiveName.test(entry.name)) continue;
          if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
          const absolute = join(directory, entry.name);
          const relativePath = relative(policy.repositoryPath!, absolute).replaceAll("\\", "/");
          tree.push(`${entry.isDirectory() ? "[dir]" : "[file]"} ${relativePath}`);
          if (entry.isDirectory()) walk(absolute, depth + 1);
          else if (importantNames.has(entry.name.toLowerCase()) && statSync(absolute).size <= 100_000) important.push(`\n--- ${relativePath} ---\n${readFileSync(absolute, "utf8")}`);
        }
      };
      walk(policy.repositoryPath, 0);
      sections.push(`\nApproved repository: ${policy.repositoryPath}`);
      sections.push(...important);
      sections.push(`\nRepository map:\n${tree.join("\n")}`);
    }

    for (const documentPath of policy.documents) {
      const content = readFileSync(documentPath, "utf8").slice(0, 50_000);
      sections.push(`\n--- Approved document: ${documentPath} ---\n${content}`);
    }
    return sections.join("\n").slice(0, maxCharacters);
  }
}