import { readFileSync } from "node:fs";
import type { ThemeContract } from "./theme.ts";

export type CatalogItem = {
  id: string; version: 1; family: ThemeContract["family"] | "shared";
  capabilities: string[]; dependencies: string[]; variants: string[]; states: string[];
  source: string; outputPath: string; responsive: string; fixture: string;
  provenance: { origin: "borg-authored"; license: "project-owned" };
  evidence: { status: "pending"; viewports: number[] };
};

const entries = [
  ["primitives", "shared", ["forms", "dialog", "drawer", "tabs", "menu", "notification", "disclosure"], []],
  ["editorial", "editorial", ["hero", "gallery", "contact", "navigation", "footer"], ["primitives"]],
  ["commerce", "conversion", ["products", "filter", "cart", "pricing"], ["primitives"]],
  ["workspace", "workspace", ["table", "sort", "edit", "states"], ["primitives"]],
] as const;

export const catalog: readonly CatalogItem[] = entries.map(([id, family, capabilities, dependencies]) => ({
  id, version: 1, family, capabilities: [...capabilities], dependencies: [...dependencies],
  variants: id === "primitives" ? ["default", "quiet", "drawer"] : ["default"],
  states: ["default", "focus", "empty", "error", "success"],
  source: `${id}.tsx.txt`, outputPath: `src/borg/${id}.tsx`,
  responsive: "390px single column; 820px compact composition; 1440px full layout. Keyboard and reduced-motion support required.",
  fixture: `${id} exported demo`, provenance: { origin: "borg-authored", license: "project-owned" },
  evidence: { status: "pending", viewports: [390, 820, 1440] },
}));

export function selectCatalog(family: ThemeContract["family"], capabilities: string[] = []): CatalogItem[] {
  const ids = new Set(catalog.filter((item) => item.family === family || item.capabilities.some((value) => capabilities.includes(value))).map((item) => item.id));
  for (const id of [...ids]) for (const dependency of catalog.find((item) => item.id === id)!.dependencies) ids.add(dependency);
  return catalog.filter((item) => ids.has(item.id));
}

export function catalogFiles(items: readonly CatalogItem[]): Record<string, string> {
  const files: Record<string, string> = {};
  for (const item of items) {
    const canonical = catalog.find((entry) => entry.id === item.id && entry.version === item.version);
    if (!canonical) throw new Error(`Unknown catalog entry: ${item.id}`);
    files[canonical.outputPath] = readFileSync(new URL(`../templates/${canonical.source}`, import.meta.url), "utf8");
  }
  files["src/borg/foundation.css"] = readFileSync(new URL("../templates/foundation.css", import.meta.url), "utf8");
  return files;
}
