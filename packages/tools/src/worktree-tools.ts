import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { BrowserVerification, type BrowserEvidenceReport } from "../../browser-verification/src/index.ts";
import { VisualRegressionService } from "../../visual-regression/src/index.ts";
import { ProcessRuntime, type ProcessKind } from "../../process-runtime/src/index.ts";
import type { TaskState, WorkflowState } from "../../core/src/contracts.ts";

export interface RecordedApproval {
  taskId: string;
  status: "REQUESTED" | "APPROVED" | "REJECTED";
  worktreePath: string | null;
  baseCommit: string | null;
}

export interface TaskToolContext {
  taskId: string;
  taskState?: TaskState;
  attemptPhase?: WorkflowState["attemptPhase"];
}
export interface WorktreeToolOptions {
  worktreeRoot: string;
  findApproval(taskId: string): RecordedApproval | null;
  findObservation?(taskId: string, observationId: string): { tool: string; output: unknown; sha256: string } | null;
  browser?: BrowserVerification;
  visualRegression?: VisualRegressionService;
  processRuntime?: ProcessRuntime;
  environmentForTask?: (taskId: string) => Record<string, string>;
}

interface CommandResult {
  command: string;
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

interface VerificationCommand { command: string; args: string[]; label: string; }

const MAX_FILE_BYTES = 500_000;
const MAX_ASSET_BYTES = 8_000_000;
const MAX_OUTPUT_BYTES = 120_000;
const MAX_COMMAND_SECONDS = 900;
const allowedCommands = new Set(["node", "npm", "python", "python3", "dotnet", "cargo", "go"]);

function plannedRoutes(root: string): string[] {
  const pagesPath = join(root, ".localcode", "build", "pages.json");
  if (!existsSync(pagesPath) || !lstatSync(pagesPath).isFile()) return [];
  try {
    const parsed = JSON.parse(readFileSync(pagesPath, "utf8")) as { pages?: Array<{ route?: string | null }> };
    return (parsed.pages ?? []).map((page) => String(page.route ?? "")).filter((route) => route.startsWith("/"));
  } catch {
    return [];
  }
}

function verifiedPageRoutes(root: string): Array<{ route: string; name: string }> {
  const pagesPath = join(root, ".localcode", "build", "pages.json");
  if (!existsSync(pagesPath) || !lstatSync(pagesPath).isFile()) return [];
  try {
    const parsed = JSON.parse(readFileSync(pagesPath, "utf8")) as { pages?: Array<{ route?: string | null; name?: string; status?: string }> };
    return (parsed.pages ?? [])
      .filter((page) => page.status === "verified" && page.route?.startsWith("/"))
      .map((page) => ({ route: String(page.route), name: String(page.name ?? page.route) }));
  } catch {
    return [];
  }
}

function detectedBrowserServer(root: string): { command: string; args: string[]; url: string } | null {
  const packagePath = join(root, "package.json");
  if (!existsSync(packagePath) || !lstatSync(packagePath).isFile()) return null;
  try {
    const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as { scripts?: Record<string, unknown> };
    for (const script of ["dev", "start", "serve", "preview"]) {
      if (typeof parsed.scripts?.[script] === "string" && parsed.scripts[script].trim()) {
        return { command: "npm", args: ["run", script], url: "http://127.0.0.1:5173" };
      }
    }
  } catch {
    return null;
  }
  return null;
}

function routeMatches(pathname: string, planned: string) {
  const segments = (value: string) => value.split("/").filter(Boolean);
  const actual = segments(pathname);
  const expected = segments(planned);
  if (actual.length !== expected.length) return false;
  return expected.every((segment, index) =>
    segment.startsWith(":") || /^\[[^\]]+\]$/.test(segment) || segment === actual[index]);
}

export function validateBrowserEvidence(evidence: BrowserEvidenceReport | null, commandPassed: boolean, routes: string[] = []): BrowserEvidenceReport | null {
  if (!evidence) return null;
  const issues = [...evidence.issues];
  if (!commandPassed) issues.push("Browser evidence was not accepted because deterministic verification commands failed.");
  if (evidence.dom.some((node) => node.text?.includes("BORG is preparing the approved design."))) {
    issues.push("Preview still shows the BORG starter placeholder; implemented UI is not connected to the application entrypoint.");
  }
  const placeholderPattern = /\b(?:lorem ipsum|coming soon|placeholder(?: text)?|todo:|dashboard content will be displayed here|content will be displayed here|replace me|sample content)\b/i;
  const placeholderNode = evidence.dom.find((node) => node.visible && placeholderPattern.test(node.text ?? ""));
  if (placeholderNode) {
    issues.push(`Visible placeholder or filler content remains in the rendered product: "${placeholderNode.text.slice(0, 160)}".`);
  }
  const deadButtons = evidence.dom.filter((node) =>
    node.visible && node.tag === "button" && !node.disabled && node.actionable === false);
  if (deadButtons.length) {
    const labels = deadButtons.slice(0, 5).map((node) => node.name || node.text || node.selector);
    issues.push(`Visible enabled controls appear to have no action: ${labels.join(", ")}.`);
  }
  const inertLinks = evidence.dom.filter((node) =>
    node.visible && node.tag === "a" && !node.disabled && node.actionable === false);
  if (inertLinks.length) {
    const labels = inertLinks.slice(0, 5).map((node) => node.name || node.text || node.selector);
    issues.push(`Visible links have no meaningful destination: ${labels.join(", ")}.`);
  }
  if (routes.length && evidence.url) {
    const current = new URL(evidence.url);
    const invalidRoutes = evidence.dom.flatMap((node) => {
      if (!node.visible || node.tag !== "a" || !node.href) return [];
      let href: URL;
      try { href = new URL(node.href); } catch { return []; }
      if (href.origin !== current.origin) return [];
      if (href.hash && href.pathname === current.pathname) return [];
      return routes.some((route) => routeMatches(href.pathname, route))
        ? []
        : [`${node.name || node.text || node.selector} -> ${href.pathname}`];
    });
    if (invalidRoutes.length) {
      issues.push(`Visible internal links point outside the approved page registry: ${[...new Set(invalidRoutes)].slice(0, 8).join(", ")}.`);
    }
  }
  return issues.length === evidence.issues.length ? evidence : { ...evidence, passed: false, issues };
}

export const worktreeToolDefinitions = {
  worktree_observation_read: {
    type: "function",
    function: {
      name: "worktree_observation_read",
      description: "Retrieve historical tool evidence by observation ID from this task's durable history. Returns a page of the original serialized JSON, not current source. Use worktree_read before patching current files.",
      parameters: { type: "object", required: ["observation_id"], properties: { observation_id: { type: "string" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 4000 } } },
    },
  },
  worktree_stat: {
    type: "function",
    function: {
      name: "worktree_stat",
      description: "Check whether an optional worktree-relative path exists and report its type without failing when it is absent. Use this before reading optional configuration files.",
      parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
    },
  },
  worktree_list: {
    type: "function",
    function: {
      name: "worktree_list",
      description: "List real files and directories inside the approved task worktree before choosing paths to read or edit.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          depth: { type: "integer", minimum: 0, maximum: 5 },
          max_entries: { type: "integer", minimum: 1, maximum: 500 },
        },
      },
    },
  },
  worktree_read: {
    type: "function",
    function: {
      name: "worktree_read",
      description: "Read exact source from the approved worktree. For large files, specify a 1-based inclusive start_line/end_line range. Hash covers the entire file.",
      parameters: { type: "object", required: ["path"], properties: { path: { type: "string" }, known_sha256: { type: "string", description: "Optional previously read whole-file hash. Returns notModified only when current bytes match; omit to retrieve source again." }, start_line: { type: "integer", minimum: 1 }, end_line: { type: "integer", minimum: 1 } } },
    },
  },
  worktree_read_many: {
    type: "function",
    function: {
      name: "worktree_read_many",
      description: "Read up to 6 related text files together, with content hashes, from the approved worktree. Prefer this for related imports and components. Maximum combined result is 24000 characters; request fewer files if exceeded.",
      parameters: { type: "object", required: ["paths"], properties: { paths: { type: "array", minItems: 1, maxItems: 6, items: { type: "string" } } } },
    },
  },
  worktree_write: {
    type: "function",
    function: {
      name: "worktree_write",
      description: "Create or replace a text file inside the approved task worktree. Missing parent directories are created safely and automatically.",
      parameters: {
        type: "object", required: ["path", "content"],
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          overwrite: { type: "boolean" },
        },
      },
    },
  },
  worktree_patch: {
    type: "function",
    function: {
      name: "worktree_patch",
      description: "Apply an exact text replacement inside the approved task worktree. To create a new file, use an empty old_text and a path that does not exist. Missing parent directories are created safely and automatically.",
      parameters: {
        type: "object", required: ["path", "old_text", "new_text"],
        properties: {
          path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" },
          expected_replacements: { type: "integer", minimum: 1, maximum: 100 },
        },
      },
    },
  },
  worktree_command: {
    type: "function",
    function: {
      name: "worktree_command",
      description: "Run a bounded command that exits inside the approved task worktree without a shell. Use browser_server_start for persistent development servers; never run npm dev/start/serve/preview here.",
      parameters: {
        type: "object", required: ["command"],
        properties: {
          command: { type: "string", enum: [...allowedCommands] },
          args: { type: "array", maxItems: 40, items: { type: "string" } },
          cwd: { type: "string" }, timeout_seconds: { type: "integer", minimum: 1, maximum: MAX_COMMAND_SECONDS },
        },
      },
    },
  },
  git_status: {
    type: "function",
    function: { name: "git_status", description: "Show concise Git status for the approved task worktree.", parameters: { type: "object", properties: {} } },
  },
  git_diff: {
    type: "function",
    function: { name: "git_diff", description: "Show the bounded Git diff for the approved task worktree.", parameters: { type: "object", properties: { path: { type: "string" } } } },
  },
  verification_profiles: {
    type: "function",
    function: { name: "verification_profiles", description: "List deterministic verification profiles detected for the approved task worktree.", parameters: { type: "object", properties: {} } },
  },
  verification_run: {
    type: "function",
    function: {
      name: "verification_run",
      description: "Run a deterministic bounded verification profile in the approved task worktree.",
      parameters: { type: "object", properties: { profile: { type: "string", enum: ["quick", "full"] } } },
    },
  },
} as const;

function isInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

function safeRelativePath(value: unknown): string {
  const path = String(value ?? "").trim().replaceAll("\\", "/");
  if (!path || path.includes("\0") || isAbsolute(path)) throw new Error("A non-empty worktree-relative path is required.");
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..") || segments[0].toLowerCase() === ".git") throw new Error("Unsafe worktree path.");
  return segments.join(sep);
}

function bounded(value: string, maximum = MAX_OUTPUT_BYTES): string {
  return value.length > maximum ? `${value.slice(0, maximum)}\n… output truncated by BORG …` : value;
}

type StyleContractViolation = { path: string; line: number; message: string };

function changedSourcePathsFromStatus(status: string) {
  return [...new Set(status.split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .map((value) => value.includes(" -> ") ? value.split(" -> ").at(-1)!.trim() : value)
    .map((value) => value.replaceAll("\\", "/"))
    .filter((value) => value && !value.startsWith(".localcode/") && /\.(?:tsx?|jsx?|css|scss|html)$/.test(value)))];
}


const sourceModuleExtensions = [".ts", ".tsx", ".js", ".jsx", ".css", ".scss", ".json"];

function localImportSpecifiers(content: string): string[] {
  const values = new Set<string>();
  for (const pattern of [
    /(?:from\s+|import\s*\(|require\s*\(|@import\s+(?:url\()?)[\"'](\.[^\"']+)[\"']/g,
    /\bimport\s*[\"'](\.[^\"']+)[\"']/g,
  ]) {
    for (const match of content.matchAll(pattern)) if (match[1]) values.add(match[1]);
  }
  return [...values];
}

function resolveLocalImport(root: string, fromPath: string, specifier: string): string | null {
  const clean = specifier.split(/[?#]/, 1)[0];
  const base = resolve(root, dirname(fromPath), clean);
  const candidates = [
    base,
    ...sourceModuleExtensions.map((extension) => base + extension),
    ...sourceModuleExtensions.map((extension) => join(base, "index" + extension)),
  ];
  for (const candidate of candidates) {
    if (!isInside(root, candidate) || !existsSync(candidate) || !lstatSync(candidate).isFile()) continue;
    if (statSync(candidate).size > MAX_FILE_BYTES) continue;
    return relative(root, candidate).replaceAll("\\", "/");
  }
  return null;
}

function reachableSourceFiles(root: string): Set<string> {
  const entries = [
    "src/main.tsx", "src/main.ts", "src/main.jsx", "src/main.js",
    "src/index.tsx", "src/index.ts", "src/index.jsx", "src/index.js",
  ].filter((path) => existsSync(join(root, path)) && lstatSync(join(root, path)).isFile());
  const reachable = new Set<string>();
  const pending = [...entries];
  while (pending.length && reachable.size < 400) {
    const path = pending.shift()!;
    if (reachable.has(path)) continue;
    reachable.add(path);
    const absolute = join(root, path);
    if (!existsSync(absolute) || !lstatSync(absolute).isFile() || statSync(absolute).size > MAX_FILE_BYTES) continue;
    const content = readFileSync(absolute, "utf8");
    for (const specifier of localImportSpecifiers(content)) {
      const resolved = resolveLocalImport(root, path, specifier);
      if (resolved && !reachable.has(resolved)) pending.push(resolved);
    }
  }
  return reachable;
}

function renderIntegrityViolations(root: string, paths: readonly string[]): StyleContractViolation[] {
  // Strict stylesheet reachability is a BORG website invariant. Arbitrary repositories
  // may resolve imports through framework aliases that this bounded static graph does not model.
  if (!existsSync(join(root, ".borg-website.json"))) return [];
  const changedStyles = paths.filter((path) => /\.(?:css|scss)$/i.test(path));
  if (!changedStyles.length) return [];
  const reachable = reachableSourceFiles(root);
  if (!reachable.size) return [];

  const reachableStyles = [...reachable].filter((path) => /\.(?:css|scss)$/i.test(path));
  const definedVariables = new Set<string>();
  for (const path of reachableStyles) {
    const absolute = join(root, path);
    if (!existsSync(absolute) || !lstatSync(absolute).isFile()) continue;
    const content = readFileSync(absolute, "utf8");
    for (const match of content.matchAll(/(--[a-z0-9_-]+)\s*:/gi)) definedVariables.add(match[1]);
  }

  const violations: StyleContractViolation[] = [];
  for (const path of changedStyles.slice(0, 40)) {
    if (!reachable.has(path)) {
      violations.push({
        path,
        line: 1,
        message: "Changed stylesheet is not reachable from the application entrypoint. Import it from the component or from an already-reachable stylesheet before visual verification.",
      });
      continue;
    }
    const absolute = join(root, path);
    if (!existsSync(absolute) || !lstatSync(absolute).isFile()) continue;
    const content = readFileSync(absolute, "utf8");
    for (const match of content.matchAll(/var\(\s*(--[a-z0-9_-]+)\s*(,\s*[^)]*)?\)/gi)) {
      if (match[2] || definedVariables.has(match[1])) continue;
      const line = content.slice(0, match.index ?? 0).split(/\r?\n/).length;
      violations.push({
        path,
        line,
        message: `CSS custom property ${match[1]} is referenced without a fallback but is not defined by any stylesheet reachable from the application entrypoint.`,
      });
      if (violations.length >= 20) return violations;
    }
  }
  return violations;
}

function websiteBrief(root: string): string {
  const manifestPath = join(root, ".borg-website.json");
  if (!existsSync(manifestPath) || !lstatSync(manifestPath).isFile()) return "";
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { originalBrief?: unknown };
    return typeof manifest.originalBrief === "string" ? manifest.originalBrief : "";
  } catch {
    return "";
  }
}

function reachableText(root: string): string {
  return [...reachableSourceFiles(root)].map((path) => {
    const absolute = join(root, path);
    return existsSync(absolute) && lstatSync(absolute).isFile() && statSync(absolute).size <= MAX_FILE_BYTES
      ? readFileSync(absolute, "utf8")
      : "";
  }).join("\n");
}

/** Catch explicit brief violations before browser review spends a repair attempt. */
export function briefContractViolations(root: string): StyleContractViolation[] {
  const brief = websiteBrief(root);
  if (!brief) return [];
  const source = reachableText(root);
  const violations: StyleContractViolation[] = [];

  const brand = brief.match(/\bfor\s+([A-Z][A-Za-z0-9&'’.-]*(?:\s+[A-Z][A-Za-z0-9&'’.-]*){0,3})\s*,/)?.[1];
  if (brand && !source.toLowerCase().includes(brand.toLowerCase())) violations.push({
    path: "src",
    line: 1,
    message: `Brief identity drift: the approved brand \"${brand}\" is absent from entrypoint-reachable source. Preserve the approved product and audience instead of substituting a generic business.`,
  });
  const domainPhrase = brief.match(/\bfor\s+[A-Z][^,\n]{0,80},\s*(?:an?|the)\s+([^\n.]{4,120})[.!]/i)?.[1] ?? "";
  const domainStopwords = new Set(["independent", "professional", "complete", "responsive", "digital", "design", "designer", "studio", "company", "business", "service", "services", "website", "frontend"]);
  const domainAnchors = [...new Set(domainPhrase.toLowerCase().match(/[a-z][a-z-]{5,}/g) ?? [])]
    .filter((word) => !domainStopwords.has(word));
  if (domainAnchors.length && !domainAnchors.some((word) => source.toLowerCase().includes(word))) violations.push({
    path: "src",
    line: 1,
    message: `Brief domain drift: none of the approved domain anchors (${domainAnchors.slice(0, 6).join(", ")}) appear in entrypoint-reachable source. Restore brand-specific content before verification.`,
  });

  if (/\b(?:do not|don['’]t|must not|never)\s+(?:download|use)\b[^.\n]{0,80}\b(?:imagery|images?|external assets?)\b/i.test(brief)) {
    const assetsRoot = join(root, "src", "assets");
    const attribution = existsSync(assetsRoot)
      ? readdirSync(assetsRoot, { recursive: true }).map(String).find((path) => path.endsWith(".license.json"))
      : undefined;
    if (attribution) violations.push({
      path: `src/assets/${attribution.replaceAll("\\", "/")}`,
      line: 1,
      message: "The approved brief prohibits downloaded imagery, but downloaded-asset attribution metadata is present. Remove the download and use an approved local asset or authored CSS/SVG composition.",
    });
  }

  for (const match of brief.matchAll(/\b(?:display|show|say|include(?:\s+the\s+(?:text|message))?)\s*:\s*["“]([^"”]{4,240})["”]/gi)) {
    const required = match[1].trim();
    if (required && !source.includes(required)) violations.push({
      path: "src",
      line: 1,
      message: `The approved brief requires the exact visible text \"${required}\", but it is absent from entrypoint-reachable source.`,
    });
  }
  return violations.slice(0, 20);
}

/** Reject visibly unfinished source before launching the browser and visual gates. */
export function constructionReadinessViolations(root: string): StyleContractViolation[] {
  if (!websiteBrief(root)) return [];
  const reachable = [...reachableSourceFiles(root)];
  const placeholder = /\b(?:will be added here|component(?:s)? will be|project title|description of the project|header component|hero component|footer content)\b/i;
  const violations: StyleContractViolation[] = [];
  for (const path of reachable) {
    if (!/\.(?:tsx?|jsx?|html)$/i.test(path)) continue;
    const content = readFileSync(join(root, path), "utf8");
    const lines = content.split(/\r?\n/);
    const lineIndex = lines.findIndex((line) => placeholder.test(line));
    if (lineIndex >= 0) violations.push({
      path,
      line: lineIndex + 1,
      message: "Entrypoint-reachable placeholder or generic mock content remains. Complete the approved section and its interaction before browser verification.",
    });
  }

  const combined = reachable.map((path) => /\.(?:tsx?|jsx?)$/i.test(path) ? readFileSync(join(root, path), "utf8") : "").join("\n");
  const semanticClasses = [...new Set(
    [...combined.matchAll(/className\s*=\s*["'`]([^"'`]+)["'`]/g)]
      .flatMap((match) => match[1].split(/\s+/))
      .filter((name) => /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/i.test(name))
      .filter((name) => !/^(?:flex|grid|block|hidden|relative|absolute|fixed|sticky|items|justify|content|self|gap|space|p[trblxy]?|m[trblxy]?|w|min-w|max-w|h|min-h|max-h|text|font|leading|tracking|bg|border|rounded|shadow|overflow|object|z|top|right|bottom|left|inset|opacity|transition|duration|ease|scale|translate|rotate|cursor|select|sr)-/.test(name)),
  )];
  const css = reachable.filter((path) => /\.(?:css|scss)$/i.test(path)).map((path) => readFileSync(join(root, path), "utf8")).join("\n");
  const missing = semanticClasses.filter((name) => !new RegExp(`\\.${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9_-])`, "i").test(css));
  if (semanticClasses.length >= 3 && missing.length / semanticClasses.length >= 0.6) violations.push({
    path: reachable.find((path) => /\.(?:css|scss)$/i.test(path)) ?? "src",
    line: 1,
    message: `Visual readiness failed: ${missing.length} of ${semanticClasses.length} semantic component classes have no reachable stylesheet rule (${missing.slice(0, 8).join(", ")}). Connect the approved layout and responsive styling before browser review.`,
  });
  return violations.slice(0, 20);
}

function dependencyLockViolations(root: string): StyleContractViolation[] {
  if (!existsSync(join(root, ".borg-website.json"))) return [];
  const manifestPath = join(root, "package.json");
  const lockPath = join(root, "package-lock.json");
  if (!existsSync(manifestPath) || !existsSync(lockPath)) return [];
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
      packages?: Record<string, { version?: string }>;
    };
    const declared = { ...manifest.dependencies, ...manifest.devDependencies };
    return Object.keys(declared).flatMap((name) => {
      const locked = lock.packages?.[`node_modules/${name}`];
      return locked?.version ? [] : [{
        path: "package.json",
        line: 1,
        message: `Declared dependency ${name} is absent from package-lock.json. Remove the undeclared package usage or update dependencies with npm install before verification.`,
      }];
    }).slice(0, 20);
  } catch {
    return [{
      path: "package-lock.json",
      line: 1,
      message: "Dependency metadata could not be parsed; package.json and package-lock.json must remain valid and synchronized.",
    }];
  }
}

function styleContractViolations(root: string, paths: readonly string[]): StyleContractViolation[] {
  const stylesPath = join(root, ".localcode", "build", "styles.md");
  if (!existsSync(stylesPath) || !lstatSync(stylesPath).isFile()) return [];
  const contract = readFileSync(stylesPath, "utf8").toLowerCase();
  const forbidsPills = /## avoid[\s\S]*\bpills?\b/.test(contract);
  const forbidsGradients = /## avoid[\s\S]*\bgradients?\b/.test(contract);
  const forbidsGlass = /## avoid[\s\S]*\bglass(?:morphism)?\b/.test(contract);
  if (!forbidsPills && !forbidsGradients && !forbidsGlass) return [];

  const violations: StyleContractViolation[] = [];
  for (const relativePath of paths.slice(0, 40)) {
    const absolute = join(root, relativePath);
    if (!existsSync(absolute) || !lstatSync(absolute).isFile() || statSync(absolute).size > MAX_FILE_BYTES) continue;
    const content = readFileSync(absolute, "utf8");
    const lines = content.split(/\r?\n/);
    const interactivePillLines = new Set<number>();
    if (forbidsPills) {
      for (const match of content.matchAll(/<(?:button|a)\b[^>]{0,800}\bclass(?:Name)?\s*=\s*["'`][^"'`]*\brounded-full\b[^"'`]*["'`][^>]*>/gi)) {
        const offset = match.index ?? 0;
        interactivePillLines.add(content.slice(0, offset).split(/\r?\n/).length);
      }
    }
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (interactivePillLines.has(index + 1)) {
        violations.push({ path: relativePath, line: index + 1, message: "Approved global styles forbid pill-shaped action treatment; rounded-full on a button/link violates the style contract." });
      }
      if (forbidsGradients && /\b(?:bg-gradient-|from-[\w\[-]|via-[\w\[-]|to-[\w\[-])|(?:linear|radial)-gradient\s*\(/i.test(line)) {
        violations.push({ path: relativePath, line: index + 1, message: "Approved global styles forbid gradients; remove the gradient treatment." });
      }
      if (forbidsGlass && /\bbackdrop-(?:blur|filter)\b|backdrop-filter\s*:/i.test(line)) {
        violations.push({ path: relativePath, line: index + 1, message: "Approved global styles forbid glassmorphism; remove backdrop glass treatment." });
      }
      if (violations.length >= 20) return violations;
    }
  }
  return violations;
}

function npmInvocation(args: string[]): { executable: string; args: string[] } {
  const candidates = [
    process.env.npm_execpath,
    resolve(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    resolve(dirname(dirname(process.execPath)), "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const npmCli = candidates.find((candidate) => existsSync(candidate));
  if (!npmCli) throw new Error("The npm CLI could not be located for the current Node.js installation.");
  return { executable: process.execPath, args: [npmCli, ...args] };
}

async function runBounded(
  command: string,
  args: string[],
  cwd: string,
  timeoutSeconds: number,
  runtime?: ProcessRuntime,
  taskId?: string,
  kind: ProcessKind = "command",
  label?: string,
  environment: Record<string, string> = {},
): Promise<CommandResult> {
  if (!allowedCommands.has(command)) throw new Error(`Command is not allowlisted: ${command}`);
  if (args.length > 40 || args.some((argument) => argument.length > 1_000 || argument.includes("\0"))) throw new Error("Command arguments exceed the bounded command policy.");
  if (runtime && taskId) {
    const result = await runtime.run({
      taskId,
      kind,
      label: label ?? [command, ...args].join(" "),
      command,
      args,
      cwd,
      env: environment,
      redact: Object.values(environment),
      timeoutMs: Math.max(1, Math.min(MAX_COMMAND_SECONDS, timeoutSeconds)) * 1_000,
    });
    return {
      command,
      args,
      exitCode: result.exitCode ?? (result.status === "completed" ? 0 : 1),
      stdout: bounded(result.stdout),
      stderr: bounded(result.stderr),
      timedOut: result.timedOut,
      durationMs: result.durationMs ?? 0,
    };
  }
  const invocation = command === "npm" ? npmInvocation(args) : { executable: command === "node" ? process.execPath : command, args };
  const startedAt = Date.now();
  return await new Promise((resolveResult, reject) => {
    execFile(invocation.executable, invocation.args, {
      cwd, timeout: Math.max(1, Math.min(MAX_COMMAND_SECONDS, timeoutSeconds)) * 1_000,
      maxBuffer: MAX_OUTPUT_BYTES * 2, windowsHide: true,
      env: { ...process.env, CI: "1", NO_COLOR: "1", ...environment },
    }, (error, stdout, stderr) => {
      if (error && typeof (error as NodeJS.ErrnoException).code === "string" && (error as NodeJS.ErrnoException).code === "ENOENT") return reject(new Error(`Command was not found: ${command}`));
      const details = error as (Error & { code?: number | string; killed?: boolean }) | null;
      resolveResult({
        command, args, exitCode: typeof details?.code === "number" ? details.code : error ? 1 : 0,
        stdout: bounded(Object.values(environment).filter(Boolean).reduce((value, secret) => value.split(secret).join("***"), String(stdout ?? ""))),
        stderr: bounded(Object.values(environment).filter(Boolean).reduce((value, secret) => value.split(secret).join("***"), String(stderr ?? ""))),
        timedOut: Boolean(details?.killed), durationMs: Date.now() - startedAt,
      });
    });
  });
}

export class WorktreeTools {
  private readonly worktreeRoot: string;
  private readonly options: WorktreeToolOptions;
  private readonly browser: BrowserVerification;
  private readonly visualRegression: VisualRegressionService;
  private readonly processRuntime: ProcessRuntime;
  constructor(options: WorktreeToolOptions) {
    this.options = options;
    this.worktreeRoot = resolve(options.worktreeRoot);
    this.processRuntime = options.processRuntime ?? new ProcessRuntime();
    this.browser = options.browser ?? new BrowserVerification({ processRuntime: this.processRuntime, environmentForTask: options.environmentForTask });
    this.visualRegression = options.visualRegression ?? new VisualRegressionService();
  }

  definitions() { return [...Object.values(worktreeToolDefinitions).filter((tool) => tool.function.name !== "worktree_observation_read" || this.options.findObservation), ...this.browser.definitions()]; }

  externalImagePolicy(context: TaskToolContext | undefined): { allowed: boolean; reason: string | null } {
    const root = this.approvedRoot(context);
    const brief = websiteBrief(root);
    const prohibited = /\b(?:do not|don['’]t|must not|never)\s+(?:download|use)\b[^.\n]{0,80}\b(?:imagery|images?|external assets?)\b/i.test(brief);
    return prohibited
      ? { allowed: false, reason: "The approved website brief prohibits downloaded or external imagery. Use local assets or authored CSS/SVG composition." }
      : { allowed: true, reason: null };
  }

  private approvedRoot(context: TaskToolContext | undefined): string {
    if (!context?.taskId) throw new Error("An approved task context is required for worktree tools.");
    const approval = this.options.findApproval(context.taskId);
    if (!approval || approval.taskId !== context.taskId || approval.status !== "APPROVED" || !approval.worktreePath || !approval.baseCommit) throw new Error("The task does not have an approved worktree.");
    const configuredRoot = realpathSync(this.worktreeRoot);
    const worktree = realpathSync(approval.worktreePath);
    if (!isInside(configuredRoot, worktree)) throw new Error("The recorded worktree is outside BORG's managed worktree root.");
    return worktree;
  }

  private resolveExisting(root: string, relativePath: unknown): string {
    const path = resolve(root, safeRelativePath(relativePath));
    const realPath = realpathSync(path);
    if (!isInside(root, realPath)) throw new Error("Worktree path escapes through a link.");
    return realPath;
  }

  private resolveWritable(root: string, relativePath: unknown): string {
    const path = resolve(root, safeRelativePath(relativePath));
    if (!isInside(root, path)) throw new Error("Worktree path escapes the approved root.");
    let parent = dirname(path);
    while (!existsSync(parent)) {
      if (parent === root || parent === dirname(parent)) throw new Error("Worktree parent is unavailable.");
      parent = dirname(parent);
    }
    if (!statSync(parent).isDirectory() || !isInside(root, realpathSync(parent))) throw new Error("Worktree path escapes through a parent link.");
    if (existsSync(path) && !isInside(root, realpathSync(path))) throw new Error("Worktree path escapes through a link.");
    return path;
  }

  private ensureWritableParent(root: string, path: string): void {
    const parent = dirname(path);
    mkdirSync(parent, { recursive: true });
    const realParent = realpathSync(parent);
    if (!statSync(realParent).isDirectory() || !isInside(root, realParent)) throw new Error("Worktree path escapes through a parent link.");
  }

  private atomicWrite(root: string, path: string, value: string): void {
    if (Buffer.byteLength(value, "utf8") > MAX_FILE_BYTES) throw new Error("Worktree file exceeds the size limit.");
    this.ensureWritableParent(root, path);
    const temporaryPath = `${path}.borg-${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, value, "utf8");
      renameSync(temporaryPath, path);
    } finally {
      if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
    }
  }

  async execute(name: string, input: Record<string, unknown>, context?: TaskToolContext): Promise<unknown> {
    const root = this.approvedRoot(context);
    if (name === "worktree_observation_read") {
      const id = input.observation_id;
      const offset = input.offset ?? 0;
      const limit = input.limit ?? 4000;
      if (typeof id !== "string" || !id || !Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 4000) throw new Error("Invalid observation ID or page range.");
      const observation = this.options.findObservation?.(context!.taskId, id);
      if (!observation) throw new Error("Observation not found in this approved task.");
      const serialized = JSON.stringify(observation.output);
      if (createHash("sha256").update(serialized).digest("hex") !== observation.sha256) throw new Error("Observation integrity check failed.");
      const end = Math.min(serialized.length, Number(offset) + Number(limit));
      return { observationId: id, tool: observation.tool, historical: true, sha256: observation.sha256, totalCharacters: serialized.length, offset, nextOffset: end < serialized.length ? end : null, content: serialized.slice(Number(offset), end) };
    }
    if (name === "worktree_stat") {
      const requested = safeRelativePath(input.path);
      const path = resolve(root, requested);
      if (!isInside(root, path)) throw new Error("Worktree path escapes the approved root.");
      if (!existsSync(path)) return { path: requested.replaceAll("\\", "/"), exists: false, type: null, bytes: null };
      const realPath = realpathSync(path);
      if (!isInside(root, realPath)) throw new Error("Worktree path escapes through a link.");
      const value = lstatSync(realPath);
      return {
        path: relative(root, realPath).replaceAll("\\", "/"),
        exists: true,
        type: value.isFile() ? "file" : value.isDirectory() ? "directory" : "other",
        bytes: value.isFile() ? value.size : null,
      };
    }
    if (name === "worktree_list") return this.list(root, input);
    if (name === "worktree_read_many") {
      if (!Array.isArray(input.paths) || input.paths.length < 1 || input.paths.length > 6 || input.paths.some((path) => typeof path !== "string")) throw new Error("worktree_read_many requires 1 to 6 string paths.");
      const files = [];
      for (const path of [...new Set(input.paths)]) {
        files.push(await this.execute("worktree_read", { path }, context));
        if (JSON.stringify({ files }).length > 24_000) throw new Error("Batch read exceeds 24000 characters. Request fewer files or use worktree_read for an individual file.");
      }
      return { files };
    }
    if (name === "worktree_read") {
      const path = this.resolveExisting(root, input.path);
      if (!lstatSync(path).isFile() || statSync(path).size > MAX_FILE_BYTES) throw new Error("Worktree file is not a bounded regular file.");
      const content = readFileSync(path, "utf8");
      const sha256 = createHash("sha256").update(content).digest("hex");
      if (input.start_line === undefined && input.end_line === undefined && input.known_sha256 === sha256) return { path: relative(root, path), sha256, notModified: true };
      if (input.start_line !== undefined || input.end_line !== undefined) {
        const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
        const start = input.start_line ?? 1;
        const end = input.end_line ?? lines.length;
        if (!Number.isInteger(start) || !Number.isInteger(end) || Number(start) < 1 || Number(end) < Number(start)) throw new Error("Invalid source line range.");
        return { path: relative(root, path), content: lines.slice(Number(start) - 1, Number(end)).join(""), sha256, startLine: start, endLine: Math.min(Number(end), lines.length), totalLines: lines.length };
      }
      return { path: relative(root, path), content, sha256 };
    }
    if (name === "worktree_write") return this.write(root, input);
    if (name === "worktree_patch") return this.patch(root, input);
    if (name === "worktree_command") return this.command(root, input, context!);
    if (name === "git_status") return this.git(root, ["status", "--short", "--untracked-files=all"]);
    if (name === "git_diff") {
      await this.git(root, ["add", "-N", "--", "."]);
      const args = ["diff", "--no-ext-diff", "--unified=3"];
      if (input.path) args.push("--", safeRelativePath(input.path));
      return this.git(root, args);
    }
    if (name === "verification_profiles") return { profiles: this.profiles(root), visualProfiles: this.visualRegression.profiles(root) };
    if (name.startsWith("browser_")) return this.browser.execute(name, input, { taskId: context!.taskId, worktreePath: root });
    if (name === "verification_run") return this.verify(root, String(input.profile ?? "quick"), context!);
    throw new Error(`Unknown worktree tool: ${name}`);
  }

  writeImageAsset(context: TaskToolContext | undefined, relativePath: unknown, bytes: Uint8Array) {
    const root = this.approvedRoot(context);
    const path = this.resolveWritable(root, relativePath);
    if (!/\.(?:avif|gif|jpe?g|png|webp)$/i.test(path)) throw new Error("Downloaded images require an AVIF, GIF, JPEG, PNG, or WebP destination.");
    if (!bytes.byteLength || bytes.byteLength > MAX_ASSET_BYTES) throw new Error("Downloaded image exceeds the 8 MB asset limit.");
    if (existsSync(path)) throw new Error("Asset destination already exists. Choose a new filename.");
    this.ensureWritableParent(root, path);
    writeFileSync(path, bytes);
    return { path: relative(root, path).replaceAll("\\", "/"), bytes: bytes.byteLength };
  }

  private list(root: string, input: Record<string, unknown>) {
    const requested = String(input.path ?? "").trim().replaceAll("\\", "/");
    const start = requested && requested !== "." ? this.resolveExisting(root, requested) : root;
    if (!statSync(start).isDirectory()) throw new Error("Worktree list path must be a directory.");
    const maximumDepth = Math.max(0, Math.min(5, Math.floor(Number(input.depth ?? 3))));
    const maximumEntries = Math.max(1, Math.min(500, Math.floor(Number(input.max_entries ?? 300))));
    const entries: { path: string; type: "file" | "directory" }[] = [];
    const visit = (directory: string, depth: number) => {
      if (entries.length >= maximumEntries) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entries.length >= maximumEntries) return;
        if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist") continue;
        const candidate = join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        const type = entry.isDirectory() ? "directory" as const : "file" as const;
        entries.push({ path: relative(root, candidate).replaceAll("\\", "/"), type });
        if (type === "directory" && depth < maximumDepth) visit(candidate, depth + 1);
      }
    };
    visit(start, 0);
    return { root: relative(root, start).replaceAll("\\", "/") || ".", entries, truncated: entries.length >= maximumEntries };
  }

  private write(root: string, input: Record<string, unknown>) {
    const path = this.resolveWritable(root, input.path);
    const value = String(input.content ?? "");
    const overwrite = input.overwrite === true;
    const created = !existsSync(path);
    if (!created) {
      if (!lstatSync(path).isFile() || statSync(path).size > MAX_FILE_BYTES) throw new Error("Worktree file is not a bounded regular file.");
      if (!overwrite) throw new Error("Worktree file already exists. Set overwrite=true to replace it.");
    }
    this.atomicWrite(root, path, value);
    return { path: relative(root, path), created, overwritten: !created, bytes: Buffer.byteLength(value, "utf8") };
  }

  private patch(root: string, input: Record<string, unknown>) {
    const path = this.resolveWritable(root, input.path);
    const oldText = String(input.old_text ?? "");
    const newText = String(input.new_text ?? "");
    const expected = Math.max(1, Math.min(100, Math.floor(Number(input.expected_replacements ?? 1))));
    let current = "";
    let created = false;
    if (existsSync(path)) {
      if (!lstatSync(path).isFile() || statSync(path).size > MAX_FILE_BYTES) throw new Error("Worktree file is not a bounded regular file.");
      if (!oldText) throw new Error("old_text may be empty only when creating a new file.");
      current = readFileSync(path, "utf8");
    } else {
      if (oldText) throw new Error("A new file requires empty old_text.");
      created = true;
    }
    const lineEnding = current.includes("\r\n") ? "\r\n" : "\n";
    const matchText = oldText && !current.includes(oldText)
      ? oldText.replace(/\r\n|\n/g, lineEnding)
      : oldText;
    const replacementText = matchText === oldText
      ? newText
      : newText.replace(/\r\n|\n/g, lineEnding);
    const occurrences = matchText ? current.split(matchText).length - 1 : 1;
    if (occurrences !== expected) throw new Error(`Patch expected ${expected} replacement(s) but found ${occurrences}.`);
    const updated = matchText ? current.split(matchText).join(replacementText) : newText;
    if (Buffer.byteLength(updated, "utf8") > MAX_FILE_BYTES) throw new Error("Patched file exceeds the size limit.");
    this.atomicWrite(root, path, updated);
    return { path: relative(root, path), created, replacements: occurrences, bytes: Buffer.byteLength(updated, "utf8") };
  }

  private async command(root: string, input: Record<string, unknown>, context: TaskToolContext) {
    const command = String(input.command ?? "").toLowerCase();
    const args = Array.isArray(input.args) ? input.args.map(String) : [];
    const npmScript = command === "npm" && (args[0]?.toLowerCase() === "run" ? args[1] : args[0]);
    if (npmScript && ["dev", "start", "serve", "preview"].includes(npmScript.toLowerCase())) {
      throw new Error("Persistent development servers must use browser_server_start, which reuses the task preview URL.");
    }
    const cwd = input.cwd ? this.resolveExisting(root, input.cwd) : root;
    if (command === "npm" && args[0]?.toLowerCase() === "run" && args[1]) {
      let packageDirectory = cwd;
      let packagePath = "";
      while (isInside(root, packageDirectory)) {
        const candidate = join(packageDirectory, "package.json");
        if (existsSync(candidate) && lstatSync(candidate).isFile()) {
          packagePath = candidate;
          break;
        }
        if (packageDirectory === root) break;
        const parent = dirname(packageDirectory);
        if (parent === packageDirectory) break;
        packageDirectory = parent;
      }
      if (!packagePath) throw new Error(`Tool usage error: npm run ${args[1]} cannot run because no package.json exists in the approved worktree scope.`);
      const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { scripts?: Record<string, string> };
      if (!pkg.scripts?.[args[1]]) {
        throw new Error(`Tool usage error: npm script "${args[1]}" is not defined in package.json. Use verification_profiles or return control to BORG's deterministic verifier instead of guessing scripts.`);
      }
    }
    if (!statSync(cwd).isDirectory()) throw new Error("Command cwd must be a directory.");
    const kind: ProcessKind = args.some((value) => /(^|:)test$/.test(value)) ? "test"
      : args.some((value) => /(^|:)build$/.test(value)) ? "build"
        : "command";
    return runBounded(
      command,
      args,
      cwd,
      Number(input.timeout_seconds ?? 300),
      this.processRuntime,
      context.taskId,
      kind,
      [command, ...args].join(" "),
      this.options.environmentForTask?.(context.taskId) ?? {},
    );
  }

  private async git(root: string, args: string[]) {
    const result = await new Promise<CommandResult>((resolveResult) => {
      const startedAt = Date.now();
      execFile("git", ["-c", `safe.directory=${root}`, "-C", root, ...args], { timeout: 30_000, maxBuffer: MAX_OUTPUT_BYTES * 2, windowsHide: true }, (error, stdout, stderr) => {
        const details = error as (Error & { code?: number; killed?: boolean }) | null;
        resolveResult({ command: "git", args, exitCode: details?.code ?? (error ? 1 : 0), stdout: bounded(String(stdout ?? "")), stderr: bounded(String(stderr ?? "")), timedOut: Boolean(details?.killed), durationMs: Date.now() - startedAt });
      });
    });
    if (result.exitCode !== 0) throw new Error(result.stderr || "Git command failed.");
    return result;
  }

  private profiles(root: string) {
    const commands: Record<"quick" | "full", VerificationCommand[]> = { quick: [], full: [] };
    const packagePath = join(root, "package.json");
    if (existsSync(packagePath)) {
      const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { scripts?: Record<string, string> };
      const scripts = pkg.scripts ?? {};
      for (const name of ["check", "lint", "test"]) if (scripts[name]) commands.quick.push({ command: "npm", args: ["run", name], label: `npm run ${name}` });
      if (!commands.quick.length && scripts.build) commands.quick.push({ command: "npm", args: ["run", "build"], label: "npm run build" });
      commands.full.push(...commands.quick);
      if (scripts.build && !commands.quick.some((item) => item.args[1] === "build")) commands.full.push({ command: "npm", args: ["run", "build"], label: "npm run build" });
    } else if (existsSync(join(root, "Cargo.toml"))) {
      commands.quick.push({ command: "cargo", args: ["test"], label: "cargo test" });
      commands.full.push({ command: "cargo", args: ["check"], label: "cargo check" }, ...commands.quick);
    } else if (existsSync(join(root, "go.mod"))) {
      commands.quick.push({ command: "go", args: ["test", "./..."], label: "go test ./..." });
      commands.full.push(...commands.quick);
    } else if (existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "pytest.ini"))) {
      commands.quick.push({ command: "python", args: ["-m", "pytest"], label: "python -m pytest" });
      commands.full.push(...commands.quick);
    }
    return (["quick", "full"] as const).map((id) => ({ id, commands: commands[id] }));
  }

  private async verify(root: string, profileId: string, context: TaskToolContext) {
    if (profileId !== "quick" && profileId !== "full") throw new Error("Unknown verification profile.");
    const profile = this.profiles(root).find((item) => item.id === profileId)!;
    const results: (CommandResult & { label: string })[] = [];
    let browserEvidence = this.browser.latest(context.taskId);
    let commandPassed = false;
    try {
      if (!profile.commands.length) throw new Error(`No commands were detected for the ${profileId} verification profile.`);
      for (const command of profile.commands) {
        const result = await runBounded(command.command, command.args, root, MAX_COMMAND_SECONDS, this.processRuntime, context.taskId, "verification", command.label, this.options.environmentForTask?.(context.taskId) ?? {});
        results.push({ ...result, label: command.label });
        if (result.exitCode !== 0 || result.timedOut) break;
      }
      commandPassed = results.length === profile.commands.length && results.every((item) => item.exitCode === 0 && !item.timedOut);
      if (commandPassed) {
        const status = await this.git(root, ["status", "--short", "--untracked-files=all"]);
        const changedPaths = changedSourcePathsFromStatus(status.stdout);
        const staticChecks = [
          {
            label: "BORG dependency integrity",
            arg: "dependency-integrity",
            code: "BORG_DEPENDENCY",
            violations: dependencyLockViolations(root),
          },
          {
            label: "BORG style contract",
            arg: "style-contract",
            code: "BORG_STYLE",
            violations: styleContractViolations(root, changedPaths),
          },
          {
            label: "BORG render integrity",
            arg: "render-integrity",
            code: "BORG_RENDER",
            violations: renderIntegrityViolations(root, changedPaths),
          },
          {
            label: "BORG brief contract",
            arg: "brief-contract",
            code: "BORG_BRIEF",
            violations: briefContractViolations(root),
          },
          {
            label: "BORG construction readiness",
            arg: "construction-readiness",
            code: "BORG_READINESS",
            violations: constructionReadinessViolations(root),
          },
        ];
        for (const check of staticChecks) {
          if (!check.violations.length) continue;
          const stderr = check.violations.map((violation) =>
            `${violation.path}:${violation.line}:1: error ${check.code}: ${violation.message}`
          ).join("\n");
          results.push({
            command: "borg",
            args: [check.arg],
            exitCode: 1,
            stdout: "",
            stderr,
            timedOut: false,
            durationMs: 0,
            label: check.label,
          });
          commandPassed = false;
        }
      }
    } finally {
      if (commandPassed) {
        const browserContext = { taskId: context.taskId, worktreePath: root };
        if (!this.processRuntime.findRunning(context.taskId, "dev_server")) {
          const server = detectedBrowserServer(root);
          if (server) await this.browser.execute("browser_server_start", server, browserContext);
        }
        await this.browser.ensureEvidenceForVerification(browserContext, verifiedPageRoutes(root));
      }
      browserEvidence = await this.browser.closeForVerification(context.taskId);
    }
    browserEvidence = validateBrowserEvidence(browserEvidence, commandPassed, plannedRoutes(root));
    const visualRegression = this.visualRegression.compare(root, browserEvidence, profileId);
    return {
      profile: profileId,
      passed: commandPassed && (browserEvidence?.passed ?? true) && visualRegression.passed,
      commandPassed,
      results,
      browserEvidence,
      visualRegression,
    };
  }
}
