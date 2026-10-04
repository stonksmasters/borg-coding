import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DesignBriefSchema,
  PersonalStyleProfileSchema,
  evaluateStyleContractEvidence,
  personalStylePrompt,
  resolveStyleContract,
  selectStyleArchetype,
} from "../packages/design-intelligence/src/index.ts";
import { SqliteTaskRepository } from "../packages/persistence/src/sqlite-task-repository.ts";

function profile() {
  const reference = (id: string, archetypes: Array<"editorial-premium" | "service-conversion" | "product-operational">) => ({
    id, project: id, archetypes, qualityScore: 90, role: "primary" as const,
    sourceFiles: [{ path: `${id}/style.css`, sha256: "a".repeat(64) }], evidenceFiles: [],
  });
  const invariant = (id: string, enforcement: "hard" | "creative-bound") => ({ id, enforcement, rule: `${id} rule`, evidence: ["editorial"] });
  return PersonalStyleProfileSchema.parse({
    id: "johnb-adaptive-design-grammar", version: 2, status: "approved", name: "Personal style",
    corpusRoot: "C:/Code", evidenceRoot: "C:/Borg/evidence", createdAt: "2026-10-02T12:00:00.000Z", approvedAt: "2026-10-02T12:01:00.000Z",
    fingerprint: "b".repeat(64),
    corpusInventory: [
      { project: "editorial", websiteMarkers: ["package.json"], curatedReferenceId: "editorial" },
      { project: "service", websiteMarkers: ["package.json"], curatedReferenceId: "service" },
      { project: "product", websiteMarkers: ["package.json"], curatedReferenceId: "product" },
    ],
    references: [reference("editorial", ["editorial-premium"]), reference("service", ["service-conversion"]), reference("product", ["product-operational"])],
    invariants: [invariant("focal", "hard"), invariant("imagery", "hard"), invariant("color", "hard"), invariant("content", "hard"), invariant("mobile", "hard"), invariant("motion", "hard"), invariant("composition", "hard"), invariant("type", "creative-bound")],
    archetypes: [
      { id: "editorial-premium", description: "Editorial", referenceIds: ["editorial"], typography: ["Display", "Body"], composition: ["Split", "Banded"], imagery: ["Photography"], interaction: ["Restrained"] },
      { id: "service-conversion", description: "Service", referenceIds: ["service"], typography: ["Bold", "Readable"], composition: ["CTA", "Proof"], imagery: ["Service photography"], interaction: ["Reachable actions"] },
      { id: "product-operational", description: "Product", referenceIds: ["product"], typography: ["Dense", "Scannable"], composition: ["Workspace", "States"], imagery: ["Product imagery"], interaction: ["Explicit states"] },
    ],
    prohibitedPatterns: ["Emoji artwork", "Centered everything", "Repeated cards", "Arbitrary gradients", "Fabricated proof"],
  });
}

test("personal style selects an adaptive archetype and resolves enforceable constraints", () => {
  assert.equal(selectStyleArchetype("Build a local roofing quote website"), "service-conversion");
  assert.equal(selectStyleArchetype("Build an inventory dashboard"), "product-operational");
  assert.equal(selectStyleArchetype("Build a fashion portfolio"), "editorial-premium");
  const contract = resolveStyleContract(profile(), "Build a local roofing quote website");
  assert.equal(contract.archetype, "service-conversion");
  assert.deepEqual(contract.referenceIds, ["service"]);
  assert.ok(contract.hardConstraints.some((item) => /Prohibited: Emoji artwork/.test(item)));
  assert.match(personalStylePrompt(contract), /blocking requirements/);
});

test("approved personal style profiles round trip through SQLite", () => {
  const root = mkdtempSync(join(tmpdir(), "borg-personal-style-"));
  let repository: SqliteTaskRepository | null = null;
  try {
    repository = new SqliteTaskRepository(join(root, "borg.db"));
    repository.savePersonalStyleProfile(profile());
    const active = PersonalStyleProfileSchema.parse(repository.activePersonalStyleProfile());
    assert.equal(active.version, 2);
    assert.equal(active.status, "approved");
    assert.equal(repository.listPersonalStyleProfiles().length, 1);
  } finally {
    repository?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("style contract evidence blocks emoji artwork, missing imagery, and incomplete responsive proof", () => {
  const contract = resolveStyleContract(profile(), "Build a local service website");
  const brief = DesignBriefSchema.parse({
    taskId: "task", createdAt: "2026-10-02T12:00:00.000Z", audience: "Homeowners", primaryPromise: "Clear service",
    brandCharacter: ["direct", "credible", "bold"], visualDirection: "High contrast service conversion",
    typography: { display: "Bold sans", body: "Readable sans", hierarchy: "Large hero" },
    palette: [{ role: "ink", direction: "navy" }, { role: "paper", direction: "white" }, { role: "accent", direction: "orange" }],
    sections: [{ purpose: "Hero", composition: "Split", visualWeight: "high-impact" }, { purpose: "Proof", composition: "Rows", visualWeight: "balanced" }, { purpose: "CTA", composition: "Band", visualWeight: "quiet" }],
    motion: [], mobileStrategy: ["Prioritize CTA", "Crop imagery"], contentVoice: ["Specific", "Direct"],
    avoid: ["Emoji", "Fake proof", "Cards", "Pills", "Gradients"], qualityBar: ["Hierarchy", "Imagery", "Mobile", "Copy", "Contrast"],
    styleProfileVersion: contract.profileVersion, selectedArchetype: contract.archetype, referenceIds: contract.referenceIds,
    hardConstraints: contract.hardConstraints, creativeBounds: contract.creativeBounds, assetRequirements: contract.assetRequirements,
  });
  const issues = evaluateStyleContractEvidence(brief, {
    taskId: "task", passed: true, issues: [], url: "http://127.0.0.1", viewport: { width: 390, height: 844 }, capturedAt: "2026-10-02T12:00:00.000Z",
    dom: [{ selector: "h1", tag: "h1", role: null, name: null, text: "Grow with us 🌱 — Hero Image", href: null, disabled: false, visible: true, rect: { x: 0, y: 0, width: 300, height: 80 } }],
    console: [], network: [], accessibility: null, screenshots: [], responsive: [], server: null,
  });
  assert.ok(issues.some((item) => /no substantial visible image/i.test(item)));
  assert.ok(issues.some((item) => /emoji/i.test(item)));
  assert.ok(issues.some((item) => /placeholder content/i.test(item)));
  assert.ok(issues.some((item) => /mobile and desktop/i.test(item)));
});

test("style contract evidence accepts substantial accessible authored artwork", () => {
  const contract = resolveStyleContract(profile(), "Build a local service website");
  const brief = DesignBriefSchema.parse({
    taskId: "task-art", createdAt: "2026-10-02T12:00:00.000Z", audience: "Homeowners", primaryPromise: "Clear service",
    brandCharacter: ["direct", "credible", "bold"], visualDirection: "High contrast service conversion",
    typography: { display: "Bold sans", body: "Readable sans", hierarchy: "Large hero" },
    palette: [{ role: "ink", direction: "navy" }, { role: "paper", direction: "white" }, { role: "accent", direction: "orange" }],
    sections: [{ purpose: "Hero", composition: "Split", visualWeight: "high-impact" }, { purpose: "Proof", composition: "Rows", visualWeight: "balanced" }, { purpose: "CTA", composition: "Band", visualWeight: "quiet" }],
    motion: [], mobileStrategy: ["Prioritize CTA", "Crop imagery"], contentVoice: ["Specific", "Direct"],
    avoid: ["Emoji", "Fake proof", "Cards", "Pills", "Gradients"], qualityBar: ["Hierarchy", "Imagery", "Mobile", "Copy", "Contrast"],
    styleProfileVersion: contract.profileVersion, selectedArchetype: contract.archetype, referenceIds: contract.referenceIds,
    hardConstraints: contract.hardConstraints, creativeBounds: contract.creativeBounds, assetRequirements: contract.assetRequirements,
  });
  const issues = evaluateStyleContractEvidence(brief, {
    taskId: "task-art", passed: true, issues: [], url: "http://127.0.0.1", viewport: { width: 1440, height: 900 }, capturedAt: "2026-10-02T12:00:00.000Z",
    dom: [{ selector: ".hero-art", tag: "div", role: "img", name: "Layered garden terraces at dusk", text: "", href: null, disabled: false, visible: true, rect: { x: 720, y: 80, width: 560, height: 520 } }],
    console: [], network: [], accessibility: null, screenshots: [], responsive: [{ name: "mobile", width: 390 } as never, { name: "desktop", width: 1440 } as never], server: null,
  });
  assert.deepEqual(issues, []);
});
