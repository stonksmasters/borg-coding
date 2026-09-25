import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  initializeProjectModel,
  projectPlanWithVerifiedModel,
  updateVerifiedProjectModel,
} from "../packages/web-builder/src/project-model.ts";
import { fallbackProjectPlan } from "../packages/web-builder/src/slice-docs.ts";

test("verified slice components enrich the blueprint shown by the workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "borg-project-model-"));
  try {
    const fallback = fallbackProjectPlan("Build an ecommerce homepage", "ecommerce");
    const plan = { ...fallback, components: [], sitemap: fallback.sitemap.map((page) => ({ ...page, componentIds: [] })) };
    mkdirSync(join(root, "src", "components"), { recursive: true });
    writeFileSync(join(root, "src", "components", "HeroSection.tsx"), "export function HeroSection() { return <section>Hero</section>; }\n");
    writeFileSync(join(root, "src", "App.tsx"), "import { HeroSection } from './components/HeroSection'; export default function App() { return <HeroSection />; }\n");
    initializeProjectModel(root, plan);
    updateVerifiedProjectModel(root, ["src/App.tsx", "src/components/HeroSection.tsx"], ["Homepage renders"]);

    const enriched = projectPlanWithVerifiedModel(root, plan);
    assert.equal(plan.components.length, 0);
    assert.equal(enriched.components[0]?.id, "hero-section");
    assert.equal(enriched.components[0]?.usedBy[0], "home");
    assert.ok(enriched.sitemap.find((page) => page.id === "home")?.componentIds.includes("hero-section"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
