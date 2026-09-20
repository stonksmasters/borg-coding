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

export type FocusedContextInput = {
  root: string;
  scope: Exclude<ContextScope, null>;
  budgetCharacters?: number;
  productContract?: string;
};

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".css", ".scss", ".html"]);
const ignored = new Set([".git", ".borg", ".localcode", "node_modules", "dist", "build", ".next", ".vinext", ".wrangler", "coverage"]);
function hash(text: string) { return createHash("sha256").update(text).digest("hex"); }
function tokens(text: string) { return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 3 && !["frontend", "website", "working", "current", "slice", "page", "component", "review"].includes(word))); }
function bounded(text: string, maximum: number) {
  const value = text.trim();
  return value.length <= maximum ? value : `${value.slice(0, maximum)}\n[Content compacted for the slice context.]`;
}

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
  const budgetCharacters = Math.max(4_000, Math.min(80_000, input.budgetCharacters ?? 64_000));
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
  if (input.productContract?.trim()) add("document", "@borg/website-product-contract", "Pinned global website product contract", bounded(input.productContract, 12_000), true);
  const briefPath = join(root, ".localcode", "build", "brief.md");
  if (!existsSync(briefPath)) throw new Error("Project brief is missing. Repair the project model before continuing.");
  add("document", ".localcode/build/brief.md", "Approved project brief", bounded(readFileSync(briefPath, "utf8"), 8_000), true);
  add("document", ".localcode/build/plan.md", "Approved frontend phase and slice", bounded(JSON.stringify({ siteGoal: plan.siteGoal, audience: plan.audience, visualDirection: plan.visualDirection, acceptanceCriteria: plan.acceptanceCriteria, slice }, null, 2), 10_000), true);
  if (design) add("document", ".localcode/build/design-brief.md", "Approved design direction", bounded(JSON.stringify(design, null, 2), 8_000), true);
  const stylesPath = join(root, ".localcode", "build", "styles.md");
  if (existsSync(stylesPath) && lstatSync(stylesPath).isFile()) add("document", ".localcode/build/styles.md", "Approved global style system", bounded(readFileSync(stylesPath, "utf8"), 8_000), true);
  const page = input.scope?.type === "page" ? model.pages.find((item) => item.id === input.scope?.id) : null;
  const component = input.scope?.type === "component" ? model.components.find((item) => item.id === input.scope?.id) : null;
  if (input.scope && !page && !component) throw new Error(`Unknown ${input.scope.type} scope: ${input.scope.id}`);
  const relevantWords = tokens([slice.title, slice.outcome, ...slice.scope, page?.name ?? "", component?.name ?? ""].join(" "));
  const relatedPages = page ? [page] : model.pages.filter((item) => [...tokens(item.name)].some((word) => relevantWords.has(word)));
  const relatedComponents = component ? [component, ...model.components.filter((item) => component.dependencies.includes(item.id))] : model.components.filter((item) => relatedPages.some((candidate) => item.usedBy.includes(candidate.id)) || [...tokens(item.name)].some((word) => relevantWords.has(word)));
  add("registry", ".localcode/build/pages.json", "Relevant page definitions", bounded(JSON.stringify(relatedPages, null, 2), 8_000), true);
  add("registry", ".localcode/build/components.json", "Relevant components and direct dependencies", bounded(JSON.stringify(relatedComponents, null, 2), 8_000), true);
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


export function compileFocusedFrontendContext(input: FocusedContextInput): CompiledContext {
  const { root, scope } = input;
  const plan = readProjectPlan(root);
  const model = readProjectModel(root);
  if (!plan || plan.status === "proposed") throw new Error("Approved frontend project state is missing. Repair the project plan before continuing.");
  const page = scope.type === "page" ? model.pages.find((item) => item.id === scope.id) : null;
  const component = scope.type === "component" ? model.components.find((item) => item.id === scope.id) : null;
  if (!page && !component) throw new Error(`Unknown ${scope.type} scope: ${scope.id}`);

  const directlyRelatedComponents = page
    ? model.components.filter((item) => page.components.includes(item.id) || item.usedBy.includes(page.id))
    : component
      ? [component, ...model.components.filter((item) => component.dependencies.includes(item.id))]
      : [];
  const dependencyIds = new Set(directlyRelatedComponents.flatMap((item) => item.dependencies));
  const relatedComponents = [...directlyRelatedComponents];
  for (const candidate of model.components) if (dependencyIds.has(candidate.id) && !relatedComponents.some((item) => item.id === candidate.id)) relatedComponents.push(candidate);
  const relatedPages = page
    ? [page]
    : component
      ? model.pages.filter((item) => component.usedBy.includes(item.id) || item.components.includes(component.id))
      : [];

  const budgetCharacters = Math.max(6_000, Math.min(80_000, input.budgetCharacters ?? 64_000));
  const manifest: ContextItem[] = [];
  const sections: string[] = [];
  let characters = 0;
  const add = (kind: ContextItem["kind"], path: string, reason: string, content: string, required = false) => {
    const section = `--- ${path} (${reason}) ---\n${content.trim()}\n`;
    if (characters + section.length > budgetCharacters) {
      if (required) throw new Error(`Context budget is too small for required focused state: ${path}.`);
      return false;
    }
    sections.push(section);
    characters += section.length;
    manifest.push({ kind, path, reason, characters: section.length, sha256: hash(section) });
    return true;
  };

  if (input.productContract?.trim()) add("document", "@borg/website-product-contract", "Pinned global website product contract", bounded(input.productContract, 12_000), true);
  const briefPath = join(root, ".localcode", "build", "brief.md");
  if (existsSync(briefPath) && lstatSync(briefPath).isFile()) add("document", ".localcode/build/brief.md", "Approved project brief", readFileSync(briefPath, "utf8").slice(0, 8_000), true);
  add("document", ".localcode/build/plan.md", "Approved website-level constraints", bounded(JSON.stringify({
    siteGoal: plan.siteGoal,
    audience: plan.audience,
    visualDirection: plan.visualDirection,
    acceptanceCriteria: plan.acceptanceCriteria,
  }, null, 2), 10_000), true);
  const design = readPersistedDesignBrief(root);
  if (design) add("document", ".localcode/build/design-brief.md", "Approved design direction", bounded(JSON.stringify(design, null, 2), 8_000), true);
  const stylesPath = join(root, ".localcode", "build", "styles.md");
  if (existsSync(stylesPath) && lstatSync(stylesPath).isFile()) add("document", ".localcode/build/styles.md", "Approved global style system", bounded(readFileSync(stylesPath, "utf8"), 8_000), true);
  add("registry", ".localcode/build/pages.json", page ? "Selected page definition" : "Pages using selected component", bounded(JSON.stringify(relatedPages, null, 2), 8_000), true);
  add("registry", ".localcode/build/components.json", component ? "Selected component and direct dependencies" : "Components used by selected page", bounded(JSON.stringify(relatedComponents, null, 2), 8_000), true);

  for (const [name, reason] of [["decisions.md", "Recent project decisions"], ["handoff.md", "Latest project handoff"]] as const) {
    const path = join(root, ".localcode", "build", name);
    if (existsSync(path) && lstatSync(path).isFile()) add("document", `.localcode/build/${name}`, reason, readFileSync(path, "utf8").slice(-4_000));
  }

  const explicit = [...new Set([...relatedPages.flatMap((item) => item.files), ...relatedComponents.flatMap((item) => item.files)])];
  const relevantWords = tokens([
    page?.name ?? "",
    page?.purpose ?? "",
    ...(page?.sections ?? []),
    component?.name ?? "",
    component?.purpose ?? "",
    ...(component?.variants ?? []),
  ].join(" "));
  const discovered = explicit.length ? [] : sourceCandidates(root, relevantWords);
  const entrypoints = explicit.length || discovered.length ? [] : ["src/App.tsx", "src/style.css", "src/main.tsx", "app/page.tsx"].filter((path) => existsSync(join(root, path)));
  for (const path of [...new Set([...explicit, ...discovered, ...entrypoints])]) {
    const safe = validateProjectSource(root, path);
    const absolute = join(root, safe);
    if (!existsSync(absolute) || !lstatSync(absolute).isFile()) continue;
    add("source", safe, explicit.includes(path) ? "Registered source for focused object" : entrypoints.includes(path) ? "Frontend entrypoint needed to locate focused object" : "Source matched focused object", readFileSync(absolute, "utf8").slice(0, 12_000));
  }

  return { text: sections.join("\n"), manifest, characters, budgetCharacters, sliceId: `${scope.type}:${scope.id}` };
}
