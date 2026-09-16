import { lookup } from "node:dns/promises";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { createLanguageIntelligence, type LanguageIntelligenceService } from "../../language-intelligence/src/index.ts";
import type { EngineeringDiscipline, EngineeringRole } from "../../core/src/contracts.ts";
import { roleAllowsTool, specialistAllowsTool } from "../../orchestration/src/index.ts";
import type { AccessController } from "../../repository/src/access-controller.ts";
import type { RepositoryMemory } from "../../repository/src/repository-memory.ts";
import { WorktreeTools, type TaskToolContext, type WorktreeToolOptions } from "./worktree-tools.ts";

interface ToolPolicy { internetEnabled: boolean; updatedAt: string; }
export interface ToolCall { function: { name: string; arguments: Record<string, unknown> }; }
export type PermissionMode = "ask" | "plan" | "edit" | "agent";

const definitions = {
  repository_list: {
    type: "function",
    function: {
      name: "repository_list",
      description: "List files and directories inside the explicitly approved repository. Paths must be repository-relative.",
      parameters: { type: "object", properties: { path: { type: "string" }, depth: { type: "integer", minimum: 0, maximum: 6 }, max_entries: { type: "integer", minimum: 1, maximum: 1000 } } },
    },
  },
  repository_read: {
    type: "function",
    function: {
      name: "repository_read",
      description: "Read a text or source file inside the explicitly approved repository. Use a repository-relative path.",
      parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
    },
  },
  repository_search: {
    type: "function",
    function: {
      name: "repository_search",
      description: "Search for literal text inside approved repository source files. Paths must be repository-relative.",
      parameters: { type: "object", required: ["query"], properties: { query: { type: "string" }, path: { type: "string" }, max_results: { type: "integer", minimum: 1, maximum: 200 } } },
    },
  },
  repository_language_status: {
    type: "function",
    function: {
      name: "repository_language_status",
      description: "Report configured language-intelligence providers and whether each local language server is available.",
      parameters: { type: "object", properties: {} },
    },
  },
  repository_symbols: {
    type: "function",
    function: {
      name: "repository_symbols",
      description: "Find repository symbols by name in the approved repository. Prefer this over literal search for named functions, classes, interfaces, methods, types, and variables.",
      parameters: { type: "object", required: ["query"], properties: { query: { type: "string" }, max_results: { type: "integer", minimum: 1, maximum: 100 } } },
    },
  },
  repository_file_symbols: {
    type: "function",
    function: {
      name: "repository_file_symbols",
      description: "Return the structural symbol outline for an approved supported source file.",
      parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
    },
  },
  repository_definition: {
    type: "function",
    function: {
      name: "repository_definition",
      description: "Resolve the definition of the symbol at a 1-based line and column in an approved supported source file.",
      parameters: { type: "object", required: ["path", "line", "column"], properties: { path: { type: "string" }, line: { type: "integer", minimum: 1 }, column: { type: "integer", minimum: 1 } } },
    },
  },
  repository_references: {
    type: "function",
    function: {
      name: "repository_references",
      description: "Find references to the symbol at a 1-based line and column in an approved supported source file. Use this before changing shared or public symbols.",
      parameters: { type: "object", required: ["path", "line", "column"], properties: { path: { type: "string" }, line: { type: "integer", minimum: 1 }, column: { type: "integer", minimum: 1 } } },
    },
  },
  repository_implementations: {
    type: "function",
    function: {
      name: "repository_implementations",
      description: "Find implementations of the symbol at a 1-based line and column in an approved supported source file.",
      parameters: { type: "object", required: ["path", "line", "column"], properties: { path: { type: "string" }, line: { type: "integer", minimum: 1 }, column: { type: "integer", minimum: 1 } } },
    },
  },
  repository_symbol_info: {
    type: "function",
    function: {
      name: "repository_symbol_info",
      description: "Return language-server quick information for the symbol at a 1-based line and column.",
      parameters: { type: "object", required: ["path", "line", "column"], properties: { path: { type: "string" }, line: { type: "integer", minimum: 1 }, column: { type: "integer", minimum: 1 } } },
    },
  },
  repository_diagnostics: {
    type: "function",
    function: {
      name: "repository_diagnostics",
      description: "Return language diagnostics for one approved file, or for the approved workspace when path is omitted.",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
  },
  repository_file_graph: {
    type: "function",
    function: {
      name: "repository_file_graph",
      description: "Show direct import and reverse-import edges for an approved TypeScript or JavaScript file.",
      parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
    },
  },
  repository_call_hierarchy: {
    type: "function",
    function: {
      name: "repository_call_hierarchy",
      description: "Show incoming and outgoing calls for a TypeScript or JavaScript symbol at a 1-based position, with call sites.",
      parameters: { type: "object", required: ["path", "line", "column"], properties: { path: { type: "string" }, line: { type: "integer", minimum: 1 }, column: { type: "integer", minimum: 1 } } },
    },
  },
  repository_change_impact: {
    type: "function",
    function: {
      name: "repository_change_impact",
      description: "Estimate file change impact from direct and transitive importers; optionally include references to a symbol at a 1-based position. Results are static evidence, not a guarantee of runtime behavior.",
      parameters: { type: "object", required: ["path"], properties: { path: { type: "string" }, line: { type: "integer", minimum: 1 }, column: { type: "integer", minimum: 1 } } },
    },
  },
  repository_memory_search: {
    type: "function",
    function: {
      name: "repository_memory_search",
      description: "Search durable indexed symbols, imports, review findings, and decisions from this approved repository. Results include source paths or task IDs. Refresh occurs at task start.",
      parameters: { type: "object", required: ["query"], properties: { query: { type: "string" }, max_results: { type: "integer", minimum: 1, maximum: 50 } } },
    },
  },
  web_search: {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the current public web. Use this during planning when facts, versions, documentation, standards, prices, or recommendations may have changed.",
      parameters: { type: "object", required: ["query"], properties: { query: { type: "string" }, max_results: { type: "integer", minimum: 1, maximum: 8 } } },
    },
  },
  web_fetch: {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Read a specific public HTTP or HTTPS page. Private, local, and link-local network addresses are blocked.",
      parameters: { type: "object", required: ["url"], properties: { url: { type: "string" } } },
    },
  },
} as const;

const repositoryDefinitions = [
  definitions.repository_list,
  definitions.repository_read,
  definitions.repository_search,
  definitions.repository_language_status,
  definitions.repository_symbols,
  definitions.repository_file_symbols,
  definitions.repository_definition,
  definitions.repository_references,
  definitions.repository_implementations,
  definitions.repository_symbol_info,
  definitions.repository_diagnostics,
  definitions.repository_file_graph,
  definitions.repository_call_hierarchy,
  definitions.repository_change_impact,
  definitions.repository_memory_search,
];

function isPrivateAddress(address: string): boolean {
  if (address === "::1" || address === "0.0.0.0" || address === "::") return true;
  if (address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe80:")) return true;
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  return false;
}

async function validatePublicUrl(rawUrl: string): Promise<URL> {
  const url = new URL(rawUrl);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP and HTTPS URLs are allowed.");
  if (url.username || url.password) throw new Error("URLs containing credentials are not allowed.");
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) throw new Error("Local network addresses are blocked.");
  const addresses = await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some((item) => isPrivateAddress(item.address))) throw new Error("Private or unsafe network address blocked.");
  return url;
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ").trim();
}

export class ToolBroker {
  private readonly policyPath: string;
  private readonly access: AccessController | undefined;
  private readonly worktree: WorktreeTools | undefined;
  private ollamaApiKey: string | undefined;
  private languageRoot: string | undefined;
  private language: LanguageIntelligenceService | undefined;
  private readonly memory: RepositoryMemory | undefined;

  constructor(policyPath: string, access?: AccessController, worktreeOptions?: WorktreeToolOptions, memory?: RepositoryMemory) {
    this.policyPath = policyPath;
    this.access = access;
    this.worktree = worktreeOptions ? new WorktreeTools(worktreeOptions) : undefined;
    this.memory = memory;
    this.ollamaApiKey = process.env.OLLAMA_API_KEY;
  }

  private loadPolicy(): ToolPolicy {
    if (!existsSync(this.policyPath)) return { internetEnabled: false, updatedAt: new Date().toISOString() };
    try { return JSON.parse(readFileSync(this.policyPath, "utf8")) as ToolPolicy; }
    catch { return { internetEnabled: false, updatedAt: new Date().toISOString() }; }
  }

  configure(input: { internetEnabled?: unknown; ollamaApiKey?: unknown; clearApiKey?: unknown }) {
    const policy = { internetEnabled: input.internetEnabled === true, updatedAt: new Date().toISOString() };
    const temporaryPath = `${this.policyPath}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(policy, null, 2), "utf8");
    renameSync(temporaryPath, this.policyPath);
    const incomingKey = String(input.ollamaApiKey ?? "").trim();
    if (incomingKey) this.ollamaApiKey = incomingKey;
    if (input.clearApiKey === true) this.ollamaApiKey = undefined;
    return this.status();
  }

  status() {
    const policy = this.loadPolicy();
    return { ...policy, webFetchAvailable: policy.internetEnabled, webSearchAvailable: policy.internetEnabled && Boolean(this.ollamaApiKey), apiKeyInMemory: Boolean(this.ollamaApiKey) };
  }

  toolDefinitions(mode: PermissionMode = "ask", context?: TaskToolContext, role?: EngineeringRole, disciplines?: readonly EngineeringDiscipline[]) {
    const status = this.status();
    const available = [];
    const allowed = <T extends { function: { name: string } }>(items: readonly T[]): T[] =>
      items.filter((item) =>
        (!role || roleAllowsTool(role, item.function.name))
        && (!disciplines?.length || specialistAllowsTool(disciplines, item.function.name))
      );
    if (mode !== "ask" && this.access?.load().repositoryPath) available.push(...allowed(repositoryDefinitions.filter((item) => item.function.name !== "repository_memory_search" || this.memory)));
    if ((mode === "edit" || mode === "agent") && context && this.worktree) available.push(...allowed(this.worktree.definitions()));
    if (status.internetEnabled) {
      const internet = status.webSearchAvailable ? [definitions.web_search, definitions.web_fetch] : [definitions.web_fetch];
      available.push(...allowed(internet));
    }
    return available;
  }

  async execute(call: ToolCall, mode: PermissionMode = "ask", context?: TaskToolContext, role?: EngineeringRole, disciplines?: readonly EngineeringDiscipline[]): Promise<unknown> {
    if (role && !roleAllowsTool(role, call.function.name)) throw new Error(`The ${role} role cannot invoke ${call.function.name}.`);
    if (disciplines?.length && !specialistAllowsTool(disciplines, call.function.name)) throw new Error(`The active specialist packs cannot invoke ${call.function.name}.`);
    if (call.function.name.startsWith("repository_")) {
      if (mode === "ask") throw new Error("Repository tools are unavailable in ASK mode.");
      if (!this.access) throw new Error("Repository tools are not configured.");
      if (call.function.name === "repository_list") return this.access.listFiles({ path: String(call.function.arguments.path ?? "."), depth: Number(call.function.arguments.depth ?? 2), maxEntries: Number(call.function.arguments.max_entries ?? 300) });
      if (call.function.name === "repository_read") return this.access.readFile(String(call.function.arguments.path ?? ""));
      if (call.function.name === "repository_search") return this.access.searchFiles(String(call.function.arguments.query ?? ""), { path: String(call.function.arguments.path ?? "."), maxResults: Number(call.function.arguments.max_results ?? 50) });
      if (call.function.name === "repository_memory_search") {
        if (!this.memory) throw new Error("Repository memory is not configured.");
        return this.memory.search(this.access.repositoryRootPath(), String(call.function.arguments.query ?? ""), Number(call.function.arguments.max_results ?? 20), (path) => this.access?.allowsRepositoryFile(path) === true);
      }

      const language = this.languageIntelligence();
      if (call.function.name === "repository_language_status") return { providers: language.status() };
      const path = String(call.function.arguments.path ?? "");
      const line = Number(call.function.arguments.line);
      const column = Number(call.function.arguments.column);
      if (call.function.name === "repository_symbols") return { symbols: await language.symbols(String(call.function.arguments.query ?? ""), Number(call.function.arguments.max_results ?? 50)) };
      if (call.function.name === "repository_file_symbols") return { symbols: await language.fileSymbols(path) };
      if (call.function.name === "repository_definition") return { locations: await language.definitions(path, line, column) };
      if (call.function.name === "repository_references") return { locations: await language.references(path, line, column) };
      if (call.function.name === "repository_implementations") return { locations: await language.implementations(path, line, column) };
      if (call.function.name === "repository_symbol_info") return { info: await language.quickInfo(path, line, column) };
      if (call.function.name === "repository_diagnostics") return { diagnostics: await language.diagnostics(path.trim() || undefined) };
      if (call.function.name === "repository_file_graph") return { graph: await language.fileGraph(path) };
      if (call.function.name === "repository_call_hierarchy") return { hierarchy: await language.callHierarchy(path, line, column) };
      if (call.function.name === "repository_change_impact") return { impact: await language.changeImpact(path, call.function.arguments.line === undefined ? undefined : line, call.function.arguments.column === undefined ? undefined : column) };
      throw new Error(`Unknown repository tool: ${call.function.name}`);
    }
    if (call.function.name.startsWith("worktree_") || call.function.name.startsWith("git_") || call.function.name.startsWith("verification_") || call.function.name.startsWith("browser_")) {
      if (mode !== "edit" && mode !== "agent") throw new Error("Worktree tools require EDIT or AGENT mode.");
      if (!this.worktree) throw new Error("Worktree tools are not configured.");
      return this.worktree.execute(call.function.name, call.function.arguments, context);
    }
    if (!this.status().internetEnabled) throw new Error("Internet tools are disabled by the user.");
    if (call.function.name === "web_search") return this.webSearch(String(call.function.arguments.query ?? ""), Number(call.function.arguments.max_results ?? 5));
    if (call.function.name === "web_fetch") return this.webFetch(String(call.function.arguments.url ?? ""));
    throw new Error(`Unknown or unavailable tool: ${call.function.name}`);
  }

  languageStatus() {
    return this.languageIntelligence().status();
  }

  async refreshMemory() {
    if (!this.access || !this.memory) throw new Error("Repository memory is not configured.");
    return this.memory.refresh(this.access, this.languageIntelligence());
  }

  private languageIntelligence(): LanguageIntelligenceService {
    if (!this.access) throw new Error("Repository tools are not configured.");
    const root = this.access.repositoryRootPath();
    if (!this.language || this.languageRoot !== root) {
      this.languageRoot = root;
      this.language = createLanguageIntelligence(root, { allowPath: (path) => this.access?.allowsRepositoryFile(path) === true });
    }
    return this.language;
  }

  private async webSearch(query: string, maxResults: number) {
    if (!this.ollamaApiKey) throw new Error("Ollama API key is required for web search.");
    if (!query.trim()) throw new Error("Search query is required.");
    const response = await fetch("https://ollama.com/api/web_search", {
      method: "POST",
      headers: { authorization: `Bearer ${this.ollamaApiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ query: query.trim(), max_results: Math.max(1, Math.min(8, Math.floor(maxResults))) }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Web search failed (${response.status}).`);
    const result = await response.json() as { results?: { title: string; url: string; content: string }[] };
    return { query: query.trim(), results: (result.results ?? []).slice(0, 8) };
  }

  private async webFetch(rawUrl: string) {
    let url = await validatePublicUrl(rawUrl);
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000), headers: { "user-agent": "BORG-Code/0.3" } });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error("Redirect did not include a destination.");
        url = await validatePublicUrl(new URL(location, url).toString());
        continue;
      }
      if (!response.ok) throw new Error(`Page fetch failed (${response.status}).`);
      const contentType = response.headers.get("content-type") ?? "";
      if (!/(text\/|application\/(json|xml|xhtml\+xml))/i.test(contentType)) throw new Error("Only text web pages can be fetched.");
      const declaredLength = Number(response.headers.get("content-length") ?? 0);
      if (declaredLength > 1_000_000) throw new Error("Page is too large to fetch safely.");
      const raw = (await response.text()).slice(0, 250_000);
      return { url: url.toString(), content: contentType.includes("html") ? htmlToText(raw).slice(0, 60_000) : raw.slice(0, 60_000) };
    }
    throw new Error("Too many redirects.");
  }
}
