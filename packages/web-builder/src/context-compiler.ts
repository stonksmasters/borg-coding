import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { readPersistedDesignBrief, readProjectPlan, readSliceState, type ProjectPlan, type SliceState } from "./slice-docs.ts";
import { readProjectModel, validateProjectSource } from "./project-model.ts";

export type ContextScope = { type: "page" | "component"; id: string } | null;
export type ContextInput = {
  root: string;
  phase: "frontend";
  sliceIndex: number;
  scope?: ContextScope;
  budgetCharacters?: number;
  authority?: { plan: ProjectPlan; state: SliceState };
  productContract?: string;
};
export type ContextItem = { kind: "document" | "registry" | "source"; path: string; reason: string; characters: number; sha256: string };
export type CompiledContext = { text: string; manifest: ContextItem[]; characters: number; budgetCharacters: number; sliceId: string };

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".css", ".scss", ".html"]);
const ignored = new Set([".git", ".borg", ".localcode", "node_modules", "dist", "build", ".next", ".vinext", ".wrangler", "coverage"]);
function hash(text: string) { return createHash("sha256").update(text).digest("hex"); }
function tokens(text: string) { return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 3 && !["frontend", "website", "working", "current", "slice", "page", "component", "review"].includes(word))); }

function sourceCandidates(root: string, relevant: Set<string>) {
  const found: string[] = [];
  const walk = (directory: string, prefix: string) => {
    if (found.length >= 500) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (found.length >= 500 || entry.isSymbolicLink() || ignored.has(entry.name)) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { walk(join(directory, entry.name), relative); continue; }
      if (!entry.isFile() || !sourceExtensions.has(extname(entry.name).toLowerCase())) continue;
      if (statSync(join(directory, entry.name)).size > 100_000) continue;
      try { found.push(validateProjectSource(root, relative)); } catch { /* Excluded source. */ }
    }
  };
  for (const directory of ["src", "app", "components"]) if (existsSync(join(root, directory)) && lstatSync(join(root, directory)).isDirectory()) walk(join(root, directory), directory);
  return found.map((path) => {
    const pathWords = tokens(path.replace(/([a-z])([A-Z])/g, "$1 $2"));
    let contentWords = new Set<string>();
    try { contentWords = tokens(readFileSync(join(root, path), "utf8").slice(0, 16_000)); } catch { /* Candidate may disappear between scan and read. */ }
    const score = [...relevant].reduce((total, word) => total + (pathWords.has(word) ? 3 : 0) + (contentWords.has(word) ? 1 : 0), 0);
    return { path, score };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, 10).map((item) => item.path);
}

export function compileFrontendContext(input: ContextInput): CompiledContext {
  const { root } = input;
  const plan = input.authority?.plan ?? readProjectPlan(root);
  const state = input.authority?.state ?? readSliceState(root);
  if (!plan || !state || plan.status === "proposed") throw new Error("Approved frontend project state is missing. Repair the project plan before continuing.");
  const slice = plan.slices[input.sliceIndex];
  if (!slice) throw new Error(`Frontend slice ${input.sliceIndex + 1} is not in the approved plan.`);
  const model = readProjectModel(root);
  const design = readPersistedDesignBrief(root);
  const budgetCharacters = Math.max(4_000, Math.min(80_000, input.budgetCharacters ?? 36_000));
  const manifest: ContextItem[] = [];
  const sections: string[] = [];
  let characters = 0;
  const add = (kind: ContextItem["kind"], path: string, reason: string, content: string, required = false) => {
    const section = `--- ${path} (${reason}) ---\n${content.trim()}\n`;
    if (characters + section.length > budgetCharacters) {
      if (required) throw new Error(`Context budget is too small for required project state: ${path}.`);
      return false;
    }
    sections.push(section);
    characters += section.length;
    manifest.push({ kind, path, reason, characters: section.length, sha256: hash(section) });
    return true;
  };
  if (input.productContract?.trim()) add("document", "@borg/website-product-contract", "Pinned global website product contract", input.productContract.trim(), true);
  const briefPath = join(root, ".localcode", "build", "brief.md");
  if (!existsSync(briefPath)) throw new Error("Project brief is missing. Repair the project model before continuing.");
  add("document", ".localcode/build/brief.md", "Approved project brief", readFileSync(briefPath, "utf8"), true);
  add("document", ".localcode/build/plan.md", "Approved frontend phase and slice", JSON.stringify({ siteGoal: plan.siteGoal, audience: plan.audience, visualDirection: plan.visualDirection, acceptanceCriteria: plan.acceptanceCriteria, slice }, null, 2), true);
  if (design) add("document", ".localcode/build/design-brief.md", "Approved design direction", JSON.stringify(design, null, 2), true);
  const stylesPath = join(root, ".localcode", "build", "styles.md");
  if (existsSync(stylesPath) && lstatSync(stylesPath).isFile()) add("document", ".localcode/build/styles.md", "Approved global style system", readFileSync(stylesPath, "utf8").slice(0, 12_000), true);
  const page = input.scope?.type === "page" ? model.pages.find((item) => item.id === input.scope?.id) : null;
  const component = input.scope?.type === "component" ? model.components.find((item) => item.id === input.scope?.id) : null;
  if (input.scope && !page && !component) throw new Error(`Unknown ${input.scope.type} scope: ${input.scope.id}`);
  const relevantWords = tokens([slice.title, slice.outcome, ...slice.scope, page?.name ?? "", component?.name ?? ""].join(" "));
  const relatedPages = page ? [page] : model.pages.filter((item) => [...tokens(item.name)].some((word) => relevantWords.has(word)));
  const relatedComponents = component ? [component, ...model.components.filter((item) => component.dependencies.includes(item.id))] : model.components.filter((item) => relatedPages.some((candidate) => item.usedBy.includes(candidate.id)) || [...tokens(item.name)].some((word) => relevantWords.has(word)));
  add("registry", ".localcode/build/pages.json", "Relevant page definitions", JSON.stringify(relatedPages, null, 2), true);
  add("registry", ".localcode/build/components.json", "Relevant components and direct dependencies", JSON.stringify(relatedComponents, null, 2), true);
  for (const [name, reason] of [["decisions.md", "Recent project decisions"], ["handoff.md", "Latest slice handoff"], ["current-plan.md", "Current slice execution notes"]] as const) {
    const path = join(root, ".localcode", "build", name);
    if (existsSync(path) && lstatSync(path).isFile()) add("document", `.localcode/build/${name}`, reason, readFileSync(path, "utf8").slice(-4_000));
  }
  const explicit = [...new Set([...relatedPages.flatMap((item) => item.files), ...relatedComponents.flatMap((item) => item.files)])];
  const discovered = input.scope ? [] : sourceCandidates(root, relevantWords);
  const entrypoints = explicit.length || discovered.length ? [] : ["src/App.tsx", "src/style.css", "src/main.tsx"].filter((path) => existsSync(join(root, path)));
  for (const path of [...new Set([...explicit, ...discovered, ...entrypoints])]) {
    const safe = validateProjectSource(root, path);
    const absolute = join(root, safe);
    if (!existsSync(absolute) || !lstatSync(absolute).isFile()) continue;
    add("source", safe, explicit.includes(path) ? "Registered source for selected object" : entrypoints.includes(path) ? "Existing frontend entrypoint" : "Source path matches current slice", readFileSync(absolute, "utf8").slice(0, 12_000));
  }
  return { text: sections.join("\n"), manifest, characters, budgetCharacters, sliceId: slice.id };
}
