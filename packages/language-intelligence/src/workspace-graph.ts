import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import type { FileGraphResult, LanguageIntelligenceOptions } from "./index.ts";
import type { LanguageServerDefinition } from "./lsp-provider.ts";

const MAX_FILES = 500;
const MAX_DEPENDENTS = 200;
const MAX_SOURCE_BYTES = 1_000_000;
const ignoredDirectories = new Set([
  ".git", ".localcode", ".borg", ".agents", ".codex", ".vinext", ".wrangler",
  "node_modules", "dist", "build", ".next", "coverage", "target", "bin", "obj",
]);

export interface DependencyImpact {
  directDependents: string[];
  transitiveDependents: string[];
  truncated: boolean;
}

function display(root: string, absolute: string): string {
  return relative(root, absolute).replaceAll("\\", "/");
}

function withoutExtension(path: string): string {
  return path.slice(0, -extname(path).length);
}

function modulePath(path: string): string {
  const value = withoutExtension(path).replaceAll("\\", "/");
  return value.endsWith("/__init__") ? value.slice(0, -"/__init__".length) : value;
}

export class WorkspaceDependencyGraph {
  private readonly root: string;
  private readonly definition: LanguageServerDefinition;
  private readonly options: LanguageIntelligenceOptions;
  private cached: { fingerprint: string; graph: Map<string, Set<string>>; truncated: boolean } | null = null;

  constructor(root: string, definition: LanguageServerDefinition, options: LanguageIntelligenceOptions = {}) {
    this.root = resolve(root);
    this.definition = definition;
    this.options = options;
  }

  fileGraph(path: string): FileGraphResult {
    const target = this.absolute(path);
    const { graph, truncated } = this.build();
    const imports = [...(graph.get(target) ?? [])].map((file) => display(this.root, file)).sort();
    const importedBy = [...graph]
      .filter(([, dependencies]) => dependencies.has(target))
      .map(([file]) => display(this.root, file))
      .sort();
    return { path: display(this.root, target), imports, importedBy, truncated };
  }

  impact(path: string): DependencyImpact {
    const target = this.absolute(path);
    const { graph, truncated: graphTruncated } = this.build();
    const reverse = new Map<string, Set<string>>();
    for (const [file, dependencies] of graph) {
      for (const dependency of dependencies) {
        const dependents = reverse.get(dependency) ?? new Set<string>();
        dependents.add(file);
        reverse.set(dependency, dependents);
      }
    }

    const direct = [...(reverse.get(target) ?? [])].sort();
    const seen = new Set<string>([target, ...direct]);
    const queue = [...direct];
    let resultTruncated = false;
    while (queue.length) {
      const current = queue.shift()!;
      for (const dependent of reverse.get(current) ?? []) {
        if (seen.has(dependent)) continue;
        if (seen.size > MAX_DEPENDENTS) {
          resultTruncated = true;
          queue.length = 0;
          break;
        }
        seen.add(dependent);
        queue.push(dependent);
      }
    }

    return {
      directDependents: direct.map((file) => display(this.root, file)),
      transitiveDependents: [...seen]
        .filter((file) => file !== target && !direct.includes(file))
        .slice(0, MAX_DEPENDENTS)
        .map((file) => display(this.root, file))
        .sort(),
      truncated: graphTruncated || resultTruncated,
    };
  }

  private build(): { graph: Map<string, Set<string>>; truncated: boolean } {
    const discovered = this.discoverFiles();
    const files = discovered.files;
    const fingerprint = files.map((file) => {
      try {
        const info = statSync(file);
        return `${file}:${info.mtimeMs}:${info.size}`;
      } catch {
        return `${file}:missing`;
      }
    }).join("\n");
    if (this.cached?.fingerprint === fingerprint && this.cached.truncated === discovered.truncated) {
      return { graph: this.cached.graph, truncated: this.cached.truncated };
    }
    const byRelative = new Map(files.map((file) => [display(this.root, file), file]));
    const graph = new Map<string, Set<string>>();
    const contents = new Map<string, string>();
    for (const file of files) {
      try {
        if (statSync(file).size <= MAX_SOURCE_BYTES) contents.set(file, readFileSync(file, "utf8"));
      } catch {
        // Files can disappear while a repository is being edited; omit them from this snapshot.
      }
    }

    for (const file of files) {
      const source = contents.get(file);
      graph.set(file, source === undefined ? new Set() : this.dependencies(file, source, files, byRelative, contents));
    }
    this.cached = { fingerprint, graph, truncated: discovered.truncated };
    return { graph, truncated: discovered.truncated };
  }

  private dependencies(file: string, source: string, files: string[], byRelative: Map<string, string>, contents: Map<string, string>): Set<string> {
    if (this.definition.id === "python") return this.pythonDependencies(file, source, byRelative);
    if (this.definition.id === "rust") return this.rustDependencies(file, source, byRelative);
    if (this.definition.id === "go") return this.goDependencies(source, files, contents);
    return this.csharpDependencies(source, files, contents);
  }

  private pythonDependencies(file: string, source: string, byRelative: Map<string, string>): Set<string> {
    const output = new Set<string>();
    const modules = new Map<string, string>();
    for (const [rel, absolute] of byRelative) modules.set(modulePath(rel).replaceAll("/", "."), absolute);
    const current = modulePath(display(this.root, file)).replaceAll("/", ".").split(".");
    if (basename(file) !== "__init__.py") current.pop();
    const add = (name: string) => {
      const exact = modules.get(name);
      if (exact && exact !== file) output.add(exact);
    };

    for (const match of source.matchAll(/^\s*import\s+([^#\n]+)/gm)) {
      for (const item of match[1]!.split(",")) add(item.trim().split(/\s+as\s+/)[0]!);
    }
    for (const match of source.matchAll(/^\s*from\s+([.\w]+)\s+import\s+([^#\n]+)/gm)) {
      const rawModule = match[1]!;
      const dots = rawModule.match(/^\.+/)?.[0].length ?? 0;
      const suffix = rawModule.slice(dots);
      const base = dots ? current.slice(0, Math.max(0, current.length - dots + 1)) : [];
      const moduleName = [...base, ...suffix.split(".").filter(Boolean)].join(".");
      add(moduleName);
      for (const item of match[2]!.split(",")) {
        const imported = item.trim().split(/\s+as\s+/)[0]!;
        if (imported !== "*") add([moduleName, imported].filter(Boolean).join("."));
      }
    }
    return output;
  }

  private rustDependencies(file: string, source: string, byRelative: Map<string, string>): Set<string> {
    const output = new Set<string>();
    const rel = display(this.root, file);
    const directory = dirname(rel).replaceAll("\\", "/");
    const addRelativeModule = (name: string) => {
      for (const candidate of [`${directory}/${name}.rs`, `${directory}/${name}/mod.rs`].map((value) => value.replace(/^\.\//, ""))) {
        const target = byRelative.get(candidate);
        if (target && target !== file) output.add(target);
      }
    };
    for (const match of source.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*;/gm)) addRelativeModule(match[1]!);

    const srcPrefix = rel.includes("/src/") ? rel.slice(0, rel.indexOf("/src/") + 5) : rel.startsWith("src/") ? "src/" : "";
    for (const match of source.matchAll(/^\s*(?:pub\s+)?use\s+([^;]+);/gm)) {
      const cleaned = match[1]!.replace(/\{.*$/, "").replace(/^::/, "");
      const parts = cleaned.split("::").filter(Boolean);
      if (!parts.length) continue;
      let base = srcPrefix;
      if (parts[0] === "self") { base = `${directory}/`; parts.shift(); }
      else if (parts[0] === "super") { base = `${dirname(directory)}/`; parts.shift(); }
      else if (parts[0] === "crate") parts.shift();
      if (!parts.length) continue;
      for (let length = parts.length; length >= 1; length -= 1) {
        const moduleName = parts.slice(0, length).join("/");
        const candidates = [`${base}${moduleName}.rs`, `${base}${moduleName}/mod.rs`];
        const target = candidates.map((candidate) => byRelative.get(candidate.replace(/^\.\//, ""))).find(Boolean);
        if (target && target !== file) { output.add(target); break; }
      }
    }
    return output;
  }

  private goDependencies(source: string, files: string[], contents: Map<string, string>): Set<string> {
    const output = new Set<string>();
    let moduleName = "";
    try { moduleName = readFileSync(resolve(this.root, "go.mod"), "utf8").match(/^\s*module\s+(\S+)/m)?.[1] ?? ""; } catch { /* no module */ }
    if (!moduleName) return output;
    const imports = new Set<string>();
    for (const match of source.matchAll(/(?:^|\n)\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/g)) imports.add(match[1]!);
    for (const block of source.matchAll(/(?:^|\n)\s*import\s*\(([^)]*)\)/g)) {
      for (const match of block[1]!.matchAll(/(?:[\w.]+\s+)?"([^"]+)"/g)) imports.add(match[1]!);
    }
    for (const imported of imports) {
      if (imported !== moduleName && !imported.startsWith(`${moduleName}/`)) continue;
      const packageDirectory = imported === moduleName ? "" : imported.slice(moduleName.length + 1);
      for (const candidate of files) {
        if (dirname(display(this.root, candidate)).replaceAll("\\", "/") !== (packageDirectory || ".")) continue;
        if (!basename(candidate).endsWith("_test.go") && contents.has(candidate)) output.add(candidate);
      }
    }
    return output;
  }

  private csharpDependencies(source: string, files: string[], contents: Map<string, string>): Set<string> {
    const output = new Set<string>();
    const namespaces = new Set<string>();
    for (const match of source.matchAll(/^\s*(?:global\s+)?using\s+(?:static\s+)?([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*;/gm)) namespaces.add(match[1]!);
    if (!namespaces.size) return output;
    for (const candidate of files) {
      const candidateSource = contents.get(candidate);
      if (!candidateSource) continue;
      const namespace = candidateSource.match(/^\s*namespace\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/m)?.[1];
      if (namespace && namespaces.has(namespace)) output.add(candidate);
    }
    return output;
  }

  private discoverFiles(): { files: string[]; truncated: boolean } {
    const files: string[] = [];
    let truncated = false;
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || ignoredDirectories.has(entry.name)) continue;
        const absolute = resolve(directory, entry.name);
        if (entry.isDirectory()) visit(absolute);
        else if (entry.isFile() && this.definition.extensions.includes(extname(entry.name).toLowerCase())) {
          const rel = display(this.root, absolute);
          if (!this.options.allowPath || this.options.allowPath(rel)) {
            if (files.length < MAX_FILES) files.push(absolute);
            else truncated = true;
          }
        }
      }
    };
    visit(this.root);
    return { files: files.sort(), truncated };
  }

  private absolute(path: string): string {
    const absolute = resolve(this.root, path);
    const rel = relative(this.root, absolute);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Path escapes workspace root: ${path}`);
    if (!this.definition.extensions.includes(extname(absolute).toLowerCase())) throw new Error(`${this.definition.label} does not support this file: ${path}`);
    const normalized = rel.replaceAll("\\", "/");
    if (this.options.allowPath && !this.options.allowPath(normalized)) throw new Error(`Language intelligence access is not allowed for this file: ${path}`);
    const info = statSync(absolute);
    if (!info.isFile()) throw new Error(`Not a regular file: ${path}`);
    return absolute;
  }
}
