import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import type { ProjectPlan } from "./slice-docs.ts";

const status = z.enum(["planned", "in_progress", "verified"]);
const relativeSource = z.string().min(1).refine((value) => !isAbsolute(value) && !value.split(/[\\/]/).some((part) => part === ".." || part === "." || !part) && !/^[a-z]:/i.test(value), "Expected a repository-relative path.");
const page = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  route: z.string().startsWith("/").nullable(),
  purpose: z.string().default(""),
  sections: z.array(z.string()).default([]),
  files: z.array(relativeSource),
  components: z.array(z.string()),
  status,
  acceptanceCriteria: z.array(z.string()),
});
const component = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(["layout", "section", "ui", "feature"]).default("section"),
  purpose: z.string().default(""),
  files: z.array(relativeSource),
  usedBy: z.array(z.string()),
  dependencies: z.array(z.string()),
  variants: z.array(z.string()),
  status,
  acceptanceCriteria: z.array(z.string()),
});
const pagesSchema = z.object({ version: z.literal(1), pages: z.array(page) });
const componentsSchema = z.object({ version: z.literal(1), components: z.array(component) });
export type ProjectModel = { pages: z.infer<typeof page>[]; components: z.infer<typeof component>[] };

const excluded = new Set([".git", ".borg", ".agents", ".codex", "node_modules", "dist", "build", ".next", ".vinext", ".wrangler", "coverage"]);
const sensitive = /(^\.env($|\.)|secret|credential|id_rsa|id_ed25519|\.pem$|\.key$|\.pfx$)/i;
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".css", ".scss", ".html"]);

export function validateProjectSource(root: string, path: string): string {
  const value = relativeSource.parse(path).replaceAll("\\", "/");
  if (value.split("/").some((part) => excluded.has(part) || sensitive.test(part))) throw new Error(`Project source is excluded: ${value}`);
  if (!sourceExtensions.has(extname(value).toLowerCase())) throw new Error(`Project source has an unsupported file type: ${value}`);
  const canonicalRoot = realpathSync(root);
  const candidate = resolve(canonicalRoot, value);
  const fromRoot = relative(canonicalRoot, candidate);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) throw new Error(`Project source escapes the repository: ${value}`);
  if (existsSync(candidate)) {
    if (!lstatSync(candidate).isFile()) throw new Error(`Project source is not a regular file: ${value}`);
    if (lstatSync(candidate).size > 1_000_000) throw new Error(`Project source exceeds the repository file size limit: ${value}`);
    const actual = realpathSync(candidate);
    const actualRelative = relative(canonicalRoot, actual);
    if (actualRelative.startsWith("..") || isAbsolute(actualRelative)) throw new Error(`Project source escapes the repository: ${value}`);
  }
  return value;
}

function registryDirectory(root: string) {
  const parent = join(resolve(root), ".localcode");
  const directory = join(parent, "build");
  for (const path of [parent, directory]) if (existsSync(path) && !lstatSync(path).isDirectory()) throw new Error("Project registry directory is not a normal directory.");
  return directory;
}
function registryPath(root: string, name: "pages" | "components") { return join(registryDirectory(root), `${name}.json`); }
function slug(name: string) { return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "item"; }
function uniqueIds(values: Array<{ id: string }>) { if (new Set(values.map((value) => value.id)).size !== values.length) throw new Error("Project registry has duplicate IDs."); }
function validateRelationships(model: ProjectModel) {
  for (const item of model.pages) for (const id of item.components) if (!model.components.some((candidate) => candidate.id === id)) throw new Error(`Unknown component ${id} on page ${item.id}.`);
  for (const item of model.components) {
    for (const id of item.usedBy) if (!model.pages.some((candidate) => candidate.id === id)) throw new Error(`Unknown page ${id} for component ${item.id}.`);
    for (const id of item.dependencies) if (!model.components.some((candidate) => candidate.id === id)) throw new Error(`Unknown dependency ${id} for component ${item.id}.`);
  }
}

export function readProjectModel(root: string): ProjectModel {
  const pagesPath = registryPath(root, "pages");
  const componentsPath = registryPath(root, "components");
  if (!existsSync(pagesPath) || !existsSync(componentsPath)) throw new Error("Project registries are missing. Reapprove or repair the frontend plan before continuing.");
  if (!lstatSync(pagesPath).isFile() || !lstatSync(componentsPath).isFile()) throw new Error("Project registry path is not a regular file.");
  const pages = pagesSchema.parse(JSON.parse(readFileSync(pagesPath, "utf8"))).pages;
  const components = componentsSchema.parse(JSON.parse(readFileSync(componentsPath, "utf8"))).components;
  uniqueIds(pages); uniqueIds(components);
  for (const item of [...pages, ...components]) for (const path of item.files) validateProjectSource(root, path);
  validateRelationships({ pages, components });
  return { pages, components };
}

export function writeProjectModel(root: string, model: ProjectModel) {
  const directory = registryDirectory(root);
  mkdirSync(directory, { recursive: true });
  const normalized: ProjectModel = { pages: pagesSchema.parse({ version: 1, pages: model.pages }).pages, components: componentsSchema.parse({ version: 1, components: model.components }).components };
  uniqueIds(normalized.pages); uniqueIds(normalized.components);
  for (const item of [...normalized.pages, ...normalized.components]) item.files = item.files.map((path) => validateProjectSource(root, path));
  validateRelationships(normalized);
  for (const name of ["pages", "components"] as const) {
    const target = registryPath(root, name);
    if (existsSync(target) && !lstatSync(target).isFile()) throw new Error(`Project registry is not a regular file: ${name}`);
    const temporary = `${target}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, [name]: normalized[name] }, null, 2) + "\n", "utf8");
    renameSync(temporary, target);
  }
  readProjectModel(root);
}

export function initializeProjectModel(root: string, plan: ProjectPlan) {
  const existing = existsSync(registryPath(root, "pages")) && existsSync(registryPath(root, "components")) ? readProjectModel(root) : { pages: [], components: [] };
  const plannedPages = Array.isArray(plan.sitemap) && plan.sitemap.length
    ? plan.sitemap
    : plan.pages.map((name, index) => ({
        id: slug(name),
        name,
        route: index === 0 ? "/" : `/${slug(name)}`,
        purpose: `${name} page.`,
        sections: [],
        componentIds: [],
        acceptanceCriteria: plan.acceptanceCriteria,
      }));
  const pageIds = new Set(plannedPages.map((item) => item.id));
  const pages = plannedPages.map((planned) => {
    const prior = existing.pages.find((item) => item.id === planned.id);
    return {
      id: planned.id,
      name: planned.name,
      route: planned.route,
      purpose: planned.purpose,
      sections: [...planned.sections],
      files: prior?.files ?? [],
      components: [...planned.componentIds],
      status: prior?.status ?? "planned" as const,
      acceptanceCriteria: [...new Set(planned.acceptanceCriteria.length ? planned.acceptanceCriteria : plan.acceptanceCriteria)],
    };
  });

  const plannedComponents = Array.isArray(plan.components) ? plan.components : [];
  const components = plannedComponents.map((planned) => {
    const prior = existing.components.find((item) => item.id === planned.id);
    return {
      id: planned.id,
      name: planned.name,
      kind: planned.kind,
      purpose: planned.purpose,
      files: prior?.files ?? [],
      usedBy: planned.usedBy.filter((id) => pageIds.has(id)),
      dependencies: prior?.dependencies ?? [],
      variants: [...planned.variants],
      status: prior?.status ?? "planned" as const,
      acceptanceCriteria: [...planned.acceptanceCriteria],
    };
  });
  for (const prior of existing.components) {
    if (components.some((item) => item.id === prior.id)) continue;
    const usedBy = prior.usedBy.filter((id) => pageIds.has(id));
    if (usedBy.length || prior.status !== "planned") components.push({ ...prior, usedBy });
  }

  const componentIds = new Set(components.map((item) => item.id));
  for (const page of pages) page.components = page.components.filter((id) => componentIds.has(id));
  for (const component of components) for (const pageId of component.usedBy) {
    const page = pages.find((item) => item.id === pageId);
    if (page && !page.components.includes(component.id)) page.components.push(component.id);
  }
  writeProjectModel(root, { pages, components });
}

export function ensureProjectModel(root: string, plan: ProjectPlan): boolean {
  const pagesPresent = existsSync(registryPath(root, "pages"));
  const componentsPresent = existsSync(registryPath(root, "components"));
  if (pagesPresent !== componentsPresent) throw new Error("Project registries are incomplete. Repair both registry files before continuing.");
  if (pagesPresent) { readProjectModel(root); return false; }
  initializeProjectModel(root, plan);
  return true;
}

export function updateVerifiedProjectModel(root: string, changedPaths: string[], acceptanceCriteria: string[] = []) {
  const model = readProjectModel(root);
  const changed = new Set(changedPaths.map((path) => path.replaceAll("\\", "/")));
  const sourceFiles = [...changed].filter((path) => sourceExtensions.has(extname(path).toLowerCase()) && !path.startsWith(".localcode/")).map((path) => validateProjectSource(root, path));
  for (const path of sourceFiles) {
    const name = basename(path).replace(/\.[^.]+$/, "");
    if (/\.(tsx|jsx)$/.test(path) && name !== "App" && name !== "main" && /component|section|ui/i.test(path) && !model.components.some((item) => item.files.includes(path))) {
      const id = slug(name);
      if (!model.components.some((item) => item.id === id)) model.components.push({ id, name, kind: "ui", purpose: `${name} discovered from verified source.`, files: [path], usedBy: [], dependencies: [], variants: [], status: "verified", acceptanceCriteria });
    }
    const page = model.pages.find((item) => path.toLowerCase().includes(`/${item.id}/`) || slug(name) === item.id || (item.id === "home" && path === "src/App.tsx"));
    if (page && !page.files.includes(path)) {
      page.files.push(path);
      if (path.startsWith("app/") && path.endsWith("/page.tsx")) page.route = path.slice(3, -9).replace(/\[[^\]]+\]/g, ":id") || "/";
    }
  }
  for (const item of model.components) {
    const content = item.files.filter((path) => existsSync(join(root, path))).map((path) => readFileSync(join(root, path), "utf8")).join("\n");
    item.dependencies = model.components.filter((candidate) => candidate.id !== item.id && candidate.files.some((path) => content.includes(basename(path).replace(/\.[^.]+$/, "")))).map((candidate) => candidate.id);
    item.usedBy = model.pages.filter((page) => page.files.some((path) => existsSync(join(root, path)) && readFileSync(join(root, path), "utf8").includes(item.name.replaceAll(" ", "")))).map((page) => page.id);
  }
  for (const page of model.pages) page.components = model.components.filter((item) => item.usedBy.includes(page.id)).map((item) => item.id);
  for (const item of [...model.pages, ...model.components]) if (item.files.some((path) => changed.has(path))) item.status = "verified";
  writeProjectModel(root, model);
}

export function projectModelHash(model: ProjectModel) { return createHash("sha256").update(JSON.stringify(model)).digest("hex"); }
