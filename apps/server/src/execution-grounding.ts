import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

export const webInterfaceExecutionOrder = [
  "For a web-interface slice, work in runnable order.",
  "First inspect the package manifest and actual application entrypoint supplied in context.",
  "Then make the smallest entrypoint-connected vertical slice that replaces any starter placeholder and renders the approved page structure.",
  "Add extracted components, data, styling, and interactions after that runnable shell exists.",
  "Do not spend the attempt building detached components that the entrypoint does not render.",
  "Treat the visible page body, heading hierarchy, accessible names, and every enabled control as part of the slice's completion contract.",
  "Resolve the visual asset strategy before polishing: use credible supplied imagery, generated or authored artwork, or an intentional type-led composition that does not pretend a blank box is media.",
  "Treat the approved brief's asset policy as binding. If it prohibits downloaded or external imagery, do not call image_search or image_download; use existing local assets or authored SVG/CSS composition instead.",
  "When the approved brief permits external imagery and image_search/image_download are available, use them to retrieve openly licensed imagery into the worktree and preserve the generated attribution metadata; choose images for subject, crop, palette, and compositional role rather than decoration.",
  "An image path exists only after image_download returns success for that exact path. After any failed download, do not import or reference the proposed path; choose a confirmed asset or a local composition and check it with worktree_stat.",
  "Never ship gray image boxes, labels such as Hero Image or Project Image, lorem ipsum, placeholder copy, or generic mock content presented as real client work.",
  "When external imagery is unavailable, create authored SVG or CSS artwork with deliberate composition and accessible semantics; substantial CSS artwork must use role=img with a concrete aria-label so browser evidence can distinguish it from a blank placeholder.",
  "Use cards only for real grouped objects. Create section-to-section rhythm by changing scale, alignment, density, background, or media treatment instead of repeating equal grids.",
  "Write concrete brand-specific copy. Mark invented portfolio examples as concept studies and never fabricate clients, testimonials, metrics, awards, addresses, or contact details.",
  "Before returning control, inspect the final diff and render the actual entry route; a successful build alone does not complete a user-facing slice.",
  "Keep the approved product, audience, and domain nouns visible while writing copy. Before returning control, compare the rendered headings and content with the original brief so a landscape studio cannot drift into a generic technology or agency site.",
  "Run a detected build or check after connecting the page shell and again after adding a batch of components. Fix missing imports and type errors before spending effort on browser or visual review.",
].join(" ");

export class ImplementationBudgetContinuations {
  private readonly continuedAttempts = new Set<string>();

  claim(attempt: number, phase: string | null | undefined) {
    const key = `${attempt}:${phase ?? "implementation"}`;
    if (this.continuedAttempts.has(key)) return false;
    this.continuedAttempts.add(key);
    return true;
  }
}

export function isTransientModelRuntimeFailure(input: unknown) {
  const message = input instanceof Error ? input.message : String(input ?? "");
  return /Ollama returned 50[0234]|fetch failed|network error|ECONNRESET|socket hang up|terminated/i.test(message);
}

export function shouldVerifyPersistedRetryFirst(input: {
  blockedRetry: boolean;
  failure: unknown;
  changedPaths: readonly string[];
}) {
  return input.blockedRetry && input.changedPaths.length > 0 && isTransientModelRuntimeFailure(input.failure);
}

export function compactBrowserRepairEvidence(browserEvidence: unknown, specialistEvidence: unknown) {
  const browser = browserEvidence && typeof browserEvidence === "object"
    ? browserEvidence as Record<string, unknown>
    : null;
  const responsive = Array.isArray(browser?.responsive)
    ? browser.responsive.map((item) => {
        const result = item && typeof item === "object" ? item as Record<string, unknown> : {};
        const accessibility = result.accessibility && typeof result.accessibility === "object"
          ? result.accessibility as Record<string, unknown>
          : null;
        return {
          name: result.name,
          width: result.width,
          height: result.height,
          accessibility: accessibility ? { violations: accessibility.violations, incomplete: accessibility.incomplete } : null,
        };
      })
    : [];
  return JSON.stringify({
    browserEvidence: browser ? {
      passed: browser.passed,
      issues: browser.issues,
      url: browser.url,
      accessibility: browser.accessibility,
      console: browser.console,
      network: browser.network,
      routeChecks: browser.routeChecks,
      responsive,
    } : null,
    specialistEvidence,
  }).slice(0, 12_000);
}

export function browserRepairSourceHints(root: string, browserEvidence: unknown) {
  const browser = browserEvidence && typeof browserEvidence === "object" ? browserEvidence as Record<string, unknown> : null;
  const accessibility = browser?.accessibility && typeof browser.accessibility === "object"
    ? browser.accessibility as Record<string, unknown>
    : null;
  const violations = Array.isArray(accessibility?.violations) ? accessibility.violations : [];
  const needles = new Set<string>();
  for (const rawViolation of violations) {
    const violation = rawViolation && typeof rawViolation === "object" ? rawViolation as Record<string, unknown> : {};
    for (const rawNode of Array.isArray(violation.nodes) ? violation.nodes : []) {
      const node = rawNode && typeof rawNode === "object" ? rawNode as Record<string, unknown> : {};
      const html = typeof node.html === "string" ? node.html : "";
      const className = html.match(/\bclass=["']([^"']+)["']/)?.[1];
      if (className && className.length >= 8) needles.add(className);
      const id = html.match(/\bid=["']([^"']+)["']/)?.[1];
      if (id) needles.add(id);
    }
  }
  if (!needles.size) return "";
  const paths = sourceMutationSnapshot(root).paths;
  const matches: string[] = [];
  for (const path of paths) {
    const content = safeWorktreeFile(root, path);
    if (!content) continue;
    const lines = content.split(/\r?\n/);
    for (const needle of needles) {
      const lineIndex = lines.findIndex((line) => line.includes(needle));
      if (lineIndex < 0) continue;
      const start = Math.max(0, lineIndex - 2);
      const end = Math.min(lines.length, lineIndex + 3);
      matches.push(`${path}:${lineIndex + 1}\n${lines.slice(start, end).map((line, index) => `${start + index + 1}: ${line}`).join("\n")}`);
    }
  }
  if (!matches.length) return "";
  return `Likely source locations matched from the failing rendered HTML:\n${[...new Set(matches)].slice(0, 8).join("\n\n")}`;
}

function gitRead(root: string, args: string[]): string | null {
  if (!existsSync(root)) return null;
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true }).trim();
  } catch {
    return null;
  }
}

function changedSourcePaths(status: string) {
  return status.split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .map((value) => value.includes(" -> ") ? value.split(" -> ").at(-1)!.trim() : value)
    .filter((value) => value && !value.startsWith(".localcode/build/"));
}

function safeWorktreeFile(root: string, path: string) {
  const candidate = resolve(root, path);
  const rel = relative(resolve(root), candidate);
  if (rel === ".." || rel.startsWith(".." + sep)) return null;
  try {
    if (!existsSync(candidate) || !statSync(candidate).isFile() || statSync(candidate).size > 256_000) return null;
    return readFileSync(candidate, "utf8");
  } catch {
    return null;
  }
}

export function sourceMutationSnapshot(root: string) {
  const status = gitRead(root, ["status", "--porcelain", "--untracked-files=all"]) ?? "";
  const diff = gitRead(root, ["diff", "--no-ext-diff", "--binary", "--", ".", ":(exclude).localcode/build/**"]) ?? "";
  const paths = changedSourcePaths(status);
  const sourceStatus = status.split(/\r?\n/).filter((line) => line && !line.includes(".localcode/build/"));
  const fileHashes = paths.map((path) => {
    const file = safeWorktreeFile(root, path);
    return [path, file === null ? null : createHash("sha256").update(file).digest("hex")];
  });
  const fingerprint = createHash("sha256").update(JSON.stringify({ status: sourceStatus, diff, fileHashes })).digest("hex");
  return { status, diff, paths, fingerprint };
}

function directRepairDependencies(root: string, paths: string[]) {
  const dependencies = new Set<string>();
  const extensions = ["", ".ts", ".tsx", ".js", ".jsx", ".css", ".scss", ".json"];
  for (const path of paths.slice(0, 20)) {
    const content = safeWorktreeFile(root, path);
    if (!content) continue;
    const imports = [
      ...content.matchAll(/(?:from\s*|import\s*\(|require\s*\(|@import\s*)["'](\.[^"']+)["']/g),
    ].map((match) => match[1]);
    for (const specifier of imports.slice(0, 40)) {
      const absoluteBase = resolve(dirname(resolve(root, path)), specifier);
      const candidates = [
        ...extensions.map((extension) => absoluteBase + extension),
        ...extensions.filter(Boolean).map((extension) => resolve(absoluteBase, "index" + extension)),
      ];
      const match = candidates.find((candidate) => {
        const rel = relative(resolve(root), candidate);
        return rel !== ".."
          && !rel.startsWith(".." + sep)
          && existsSync(candidate)
          && statSync(candidate).isFile()
          && statSync(candidate).size <= 256_000;
      });
      if (!match) continue;
      const rel = relative(resolve(root), match).replaceAll("\\", "/");
      if (!rel.startsWith(".localcode/") && !rel.includes("/node_modules/")) dependencies.add(rel);
    }
  }
  return [...dependencies].filter((path) => !paths.includes(path)).slice(0, 20);
}

export function repairGroundingSnapshot(root: string, focusPaths: readonly string[] = []) {
  const snapshot = sourceMutationSnapshot(root);
  const normalizedFocus = [...new Set(focusPaths.map((path) => path.replaceAll("\\", "/")).filter(Boolean))];
  const basisPaths = normalizedFocus.length ? normalizedFocus : snapshot.paths;
  const dependencyPaths = directRepairDependencies(root, basisPaths);
  const changedFiles = basisPaths.slice(0, 3).map((path) => {
    const content = safeWorktreeFile(root, path);
    return content === null ? `### ${path}\n[unavailable or non-text]` : `### ${path}\n${content.slice(0, 2_500)}`;
  });
  const dependencies = dependencyPaths.slice(0, 3).map((path) => {
    const content = safeWorktreeFile(root, path);
    return content === null ? `### ${path}\n[unavailable or non-text]` : `### ${path}\n${content.slice(0, 1_500)}`;
  });
  const body = [
    "CURRENT WORKTREE GROUNDING. This snapshot is authoritative for the repair pass; do not rediscover or guess paths.",
    `Repair focus files:\n${basisPaths.length ? basisPaths.slice(0, 12).map((path) => `- ${path}`).join("\n") : "- none"}`,
    dependencyPaths.length ? `Direct relative dependencies automatically resolved from focus files:\n${dependencyPaths.map((path) => `- ${path}`).join("\n")}` : "",
    `Current source diff (bounded):\n${snapshot.diff.slice(0, 4_000) || "[no tracked diff]"}`,
    changedFiles.length ? `Current focus-file contents:\n${changedFiles.join("\n\n")}` : "",
    dependencies.length ? `Current direct-dependency contents:\n${dependencies.join("\n\n")}` : "",
    "Use this bounded neighborhood first. Read beyond it only when a direct dependency proves another file is required for the evidenced repair.",
  ].filter(Boolean).join("\n\n");
  return body.slice(0, 6_000);
}
