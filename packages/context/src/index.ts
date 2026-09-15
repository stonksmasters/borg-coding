import { basename, extname } from "node:path";
import type { WorkspaceIndexSummary } from "@borg/core";
import { RepositoryTools } from "@borg/repository";

interface WorkspaceIndex extends WorkspaceIndexSummary {
  version: 1;
  files: string[];
}

export interface TaskContext {
  summary: WorkspaceIndexSummary;
  selectedFiles: string[];
  text: string;
}

const textExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".mdx", ".css", ".scss", ".html", ".yml", ".yaml", ".toml", ".py", ".go", ".rs", ".java", ".kt", ".kts", ".cs", ".cpp", ".c", ".h", ".hpp", ".sql", ".graphql", ".gql", ".sh", ".ps1", ".bat", ".cmd", ".env", ".txt"]);
const stopWords = new Set(["about", "after", "again", "agent", "before", "borg", "build", "change", "code", "could", "create", "from", "have", "into", "just", "make", "need", "please", "repo", "repository", "should", "that", "the", "their", "then", "this", "with", "would"]);

function isTextFile(path: string): boolean {
  const name = basename(path).toLowerCase();
  return textExtensions.has(extname(path).toLowerCase()) || ["dockerfile", "makefile", "procfile", ".gitignore", ".npmrc", ".nvmrc"].includes(name);
}

function isInstructionFile(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith("agents.md") || lower.endsWith("claude.md") || lower.endsWith(".github/copilot-instructions.md");
}

function isDocFile(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.startsWith("docs/") && (lower.endsWith(".md") || lower.endsWith(".mdx")) || /^readme(?:\.[^/]+)?$/i.test(basename(path));
}

function isMetadataFile(path: string): boolean {
  const name = basename(path).toLowerCase();
  return name === "package.json" || name === "pyproject.toml" || name === "cargo.toml" || name === "go.mod" || name === "requirements.txt" || name === "composer.json" || name.startsWith("tsconfig") || name.startsWith("vite.config") || name.startsWith("next.config");
}

function languageName(path: string): string | null {
  const extension = extname(path).toLowerCase();
  const names: Record<string, string> = {
    ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript", ".py": "Python", ".go": "Go", ".rs": "Rust", ".java": "Java", ".kt": "Kotlin", ".cs": "C#", ".cpp": "C++", ".c": "C", ".sql": "SQL", ".css": "CSS", ".html": "HTML", ".md": "Markdown"
  };
  return names[extension] ?? null;
}

function tokenize(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[a-z0-9_./-]{3,}/g) ?? [])].filter((term) => !stopWords.has(term)).slice(0, 12);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class WorkspaceContext {
  private readonly repository: RepositoryTools;

  constructor(readonly root: string) {
    this.repository = new RepositoryTools(root);
  }

  async buildIndex(force = false): Promise<WorkspaceIndexSummary> {
    await this.repository.validateRoot();
    await this.repository.ensureLocalCodeExcluded();

    if (!force) {
      const cached = await this.repository.readOptional(".localcode/index.json");
      if (cached) {
        try {
          const parsed = JSON.parse(cached) as WorkspaceIndex;
          const age = Date.now() - Date.parse(parsed.generatedAt);
          if (parsed.version === 1 && parsed.root === this.repository.root && age >= 0 && age < 5 * 60 * 1000) return parsed;
        } catch {
          // Rebuild invalid cache.
        }
      }
    }

    const files = (await this.repository.listFiles()).filter((path) => !path.startsWith(".localcode/")).slice(0, 10000);
    const instructionFiles = files.filter(isInstructionFile);
    const docFiles = files.filter(isDocFile).slice(0, 200);
    const metadataFiles = files.filter(isMetadataFile).slice(0, 100);
    const languages: Record<string, number> = {};
    for (const path of files) {
      const language = languageName(path);
      if (language) languages[language] = (languages[language] ?? 0) + 1;
    }

    const index: WorkspaceIndex = {
      version: 1,
      root: this.repository.root,
      generatedAt: new Date().toISOString(),
      fileCount: files.length,
      files,
      instructionFiles,
      docFiles,
      metadataFiles,
      languages
    };
    await this.repository.write(".localcode/index.json", JSON.stringify(index, null, 2));
    return index;
  }

  async buildTaskContext(query: string): Promise<TaskContext> {
    await this.buildIndex(false);
    const raw = await this.repository.read(".localcode/index.json");
    const index = JSON.parse(raw) as WorkspaceIndex;
    const terms = tokenize(query);
    const matched = new Set<string>();

    if (terms.length) {
      try {
        const pattern = terms.map(escapeRegex).join("|");
        for (const path of await this.repository.searchFiles(pattern)) matched.add(path);
      } catch {
        // Filename ranking still provides useful context if ripgrep is unavailable.
      }
    }

    const scores = index.files.filter(isTextFile).map((path) => {
      const lower = path.toLowerCase();
      let score = 0;
      if (index.instructionFiles.includes(path)) score += 120;
      if (matched.has(path)) score += 50;
      if (index.metadataFiles.includes(path)) score += 25;
      if (index.docFiles.includes(path)) score += 18;
      for (const term of terms) {
        if (lower.includes(term)) score += 18;
        if (basename(lower).includes(term)) score += 8;
      }
      if (/\.(test|spec)\.[^.]+$/i.test(path)) score -= 2;
      return { path, score };
    }).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

    const selected = [...new Set([
      ...index.instructionFiles.slice(0, 3),
      ...scores.filter((item) => item.score > 0).slice(0, 12).map((item) => item.path),
      ...index.metadataFiles.slice(0, 3)
    ])].slice(0, 14);

    const sections: string[] = [];
    let budget = 30000;
    for (const path of selected) {
      if (budget <= 0) break;
      try {
        const content = await this.repository.read(path);
        if (content.includes("\0")) continue;
        const excerpt = content.slice(0, Math.min(6000, budget));
        budget -= excerpt.length;
        sections.push(`FILE: ${path}\n${excerpt}${content.length > excerpt.length ? "\n…[truncated]" : ""}`);
      } catch {
        // Skip files that disappear between indexing and context assembly.
      }
    }

    return {
      summary: index,
      selectedFiles: selected,
      text: sections.length ? sections.join("\n\n---\n\n") : "No repository context files were selected."
    };
  }

  async listFiles(): Promise<string[]> {
    const summary = await this.buildIndex(false);
    const raw = await this.repository.read(".localcode/index.json");
    const index = JSON.parse(raw) as WorkspaceIndex;
    return summary.fileCount ? index.files : [];
  }
}
