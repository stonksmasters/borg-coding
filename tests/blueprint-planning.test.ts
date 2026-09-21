import test from "node:test";
import assert from "node:assert/strict";
import {
  applyBlueprintFoundation,
  parseProductMap,
  parseStyleSystem,
  validateBlueprintCompletion,
  validateProductMap,
  validateStyleSystem,
} from "../packages/web-builder/src/blueprint-planning.ts";
import { fallbackProjectPlan } from "../packages/web-builder/src/slice-docs.ts";
import type { ProjectPlan, ProjectStyleSystem } from "../packages/core/src/project-domain.ts";

const concreteStyles: ProjectStyleSystem = {
  direction: "Editorial dark product system with deliberate hierarchy, restrained surfaces, strong type contrast, and dense-but-readable application composition.",
  colors: ["canvas: #0B0D10", "surface: #12161C", "raised: #181E27", "text: #F5F7FA", "muted: #98A2B3", "border: #2A313C", "accent: #B7FF5A"],
  typography: ["display: 48px/52px 650", "h1: 36px/42px 620", "h2: 28px/34px 600", "body: 15px/24px 400", "label: 12px/16px 600"],
  spacing: ["1: 4px", "2: 8px", "3: 12px", "4: 16px", "6: 24px", "8: 32px"],
  radii: ["sm: 6px", "md: 10px"],
  shadows: ["raised: 0 12px 32px rgba(0,0,0,.22)"],
  layoutPrinciples: ["content max 1440px", "desktop gutters 40px", "12-column grid with asymmetric spans"],
  motion: ["interactive 160ms", "enter 240ms"],
  responsive: ["desktop >=1200px multi-column", "tablet >=768px reduced spans", "mobile <768px recomposes content order"],
  accessibility: ["visible focus ring", "AA text contrast", "44px touch targets"],
  avoid: ["generic card grids", "arbitrary gradients", "excessive pills", "centered everything", "one-off token values"],
};

test("product-map stage creates durable routes and user journeys before component planning", () => {
  const fallback = fallbackProjectPlan("Build a commerce app", "ecommerce");
  const answer = `<borg-product-map>{"siteGoal":"Sell curated objects","audience":"Collectors","features":["Discovery","Purchase"],"sitemap":[{"id":"home","name":"Home","route":"/","purpose":"Entry","sections":["Navigation","Discovery"],"acceptanceCriteria":["entry works"]},{"id":"browse","name":"Browse","route":"/browse","purpose":"Discover","sections":["Filters","Results"],"acceptanceCriteria":["browse works"]},{"id":"product","name":"Product","route":"/products/:id","purpose":"Evaluate","sections":["Gallery","Details"],"acceptanceCriteria":["product works"]}],"flows":[{"id":"purchase","name":"Purchase","purpose":"Move discovery into evaluation","steps":["home","browse","product"]}],"backendRequired":true}</borg-product-map>`;
  const result = parseProductMap(answer, fallback);
  assert.equal(result.source, "model");
  assert.equal(result.map.sitemap.length, 3);
  assert.deepEqual(result.map.sitemap.map((page) => page.componentIds), [[], [], []]);
  assert.deepEqual(result.map.flows[0]?.steps, ["home", "browse", "product"]);
  assert.equal(validateProductMap(result.map).valid, true);
});

test("product-map parser deterministically repairs a missing comma before semantic validation", () => {
  const fallback = fallbackProjectPlan("Build a travel portfolio", "portfolio");
  const answer = `<borg-product-map>{"siteGoal":"Explore remote expeditions","audience":"Adventure travelers","features":["Discovery" "Inquiry"],"sitemap":[{"id":"home","name":"Home","route":"/","purpose":"Entry","sections":["Hero","Selected expeditions"],"acceptanceCriteria":["home works"]},{"id":"expeditions","name":"Expeditions","route":"/expeditions","purpose":"Browse","sections":["Filters","Results"],"acceptanceCriteria":["browse works"]}],"flows":[{"id":"primary","name":"Primary","purpose":"Move from entry to discovery","steps":["home","expeditions"]}],"backendRequired":false}</borg-product-map>`;
  const result = parseProductMap(answer, fallback);
  assert.equal(result.source, "repaired");
  assert.equal(result.map.features.length, 2);
  assert.equal(validateProductMap(result.map).valid, true);
  assert.match(result.reason ?? "", /missing comma/i);
});


test("product-map stage deterministically repairs a missing comma without regenerating product decisions", () => {
  const fallback = fallbackProjectPlan("Build a premium expedition website", "portfolio");
  const answer = `<borg-product-map>{"siteGoal":"Plan premium expeditions","audience":"Adventure travelers","features":["Discovery","Inquiry"],"sitemap":[{"id":"home","name":"Home","route":"/","purpose":"Entry","sections":["Navigation","Selected expeditions"],"acceptanceCriteria":["home works"]},{"id":"expeditions","name":"Expeditions","route":"/expeditions","purpose":"Browse","sections":["Filters","Results"],"acceptanceCriteria":["browse works"]}],"flows":[{"id":"discover","name":"Discover","purpose":"Move from entry to catalog","steps":["home" "expeditions"]}],"backendRequired":false}</borg-product-map>`;
  const result = parseProductMap(answer, fallback);
  assert.equal(result.source, "repaired");
  assert.deepEqual(result.map.flows[0]?.steps, ["home", "expeditions"]);
  assert.match(result.reason ?? "", /missing comma/i);
  assert.equal(validateProductMap(result.map).valid, true);
});

test("product-map stage repairs harmless trailing commas but still rejects semantic invalidity", () => {
  const fallback = fallbackProjectPlan("Build a portfolio", "portfolio");
  const syntactic = `<borg-product-map>{"siteGoal":"Show work","audience":"Clients","features":["Work",],"sitemap":[{"id":"home","name":"Home","route":"/","purpose":"Entry","sections":["Hero"],"acceptanceCriteria":["works"],},{"id":"work","name":"Work","route":"/work","purpose":"Browse","sections":["Projects"],"acceptanceCriteria":["works"]}],"flows":[{"id":"browse","name":"Browse","purpose":"Explore","steps":["home","work"],}],"backendRequired":false}</borg-product-map>`;
  const repaired = parseProductMap(syntactic, fallback);
  assert.equal(repaired.source, "repaired");
  assert.equal(validateProductMap(repaired.map).valid, true);

  const semanticallyInvalid = `<borg-product-map>{"siteGoal":"Show work","audience":"Clients","features":[],"sitemap":[{"id":"home","name":"Home","route":"/","purpose":"Entry","sections":[],"acceptanceCriteria":[]}],"flows":[],"backendRequired":false}</borg-product-map>`;
  const rejected = parseProductMap(semanticallyInvalid, fallback);
  assert.equal(rejected.source, "fallback");
  assert.match(rejected.reason ?? "", /sections|acceptance/i);
});

test("style-system stage rejects vague prose and accepts implementation-grade scales", () => {
  assert.equal(validateStyleSystem(concreteStyles).valid, true);
  const fallback = fallbackProjectPlan("Build a premium dashboard", "dashboard").styles;
  const vague = `<borg-style-system>{"direction":"Make it premium","colors":["Use dark colors"],"typography":["Strong hierarchy"],"spacing":["Consistent spacing"],"radii":["Consistent"],"shadows":[],"layoutPrinciples":["Good layout"],"motion":[],"responsive":["Mobile friendly"],"accessibility":["Accessible"],"avoid":["Generic"]}</borg-style-system>`;
  const parsed = parseStyleSystem(vague, fallback);
  assert.equal(parsed.source, "fallback");
  assert.ok(parsed.reason?.includes("concrete") || parsed.reason?.includes("needs at least"));
  assert.equal(validateStyleSystem(parsed.styles).valid, true);
});

test("style-system parser deterministically repairs malformed JSON without weakening style validation", () => {
  const fallback = fallbackProjectPlan("Build a premium editorial site", "portfolio").styles;
  const malformed = JSON.stringify(concreteStyles).replace('"surface: #12161C","raised: #181E27"', '"surface: #12161C" "raised: #181E27"');
  const parsed = parseStyleSystem(`<borg-style-system>${malformed}</borg-style-system>`, fallback);
  assert.equal(parsed.source, "repaired");
  assert.equal(validateStyleSystem(parsed.styles).valid, true);
  assert.match(parsed.reason ?? "", /missing comma/i);
});

test("blueprint completion freezes map/styles and inserts visual foundation before feature slices", () => {
  const now = new Date().toISOString();
  const map = {
    siteGoal: "Operate jobs",
    audience: "Dispatchers",
    features: ["Jobs"],
    sitemap: [
      { id: "overview", name: "Overview", route: "/", purpose: "See operations", sections: ["Summary"], componentIds: [], acceptanceCriteria: ["overview works"] },
      { id: "jobs", name: "Jobs", route: "/jobs", purpose: "Manage jobs", sections: ["Job list"], componentIds: [], acceptanceCriteria: ["jobs work"] },
    ],
    flows: [{ id: "dispatch", name: "Dispatch", purpose: "Move from overview to jobs", steps: ["overview", "jobs"] }],
    backendRequired: true,
  };
  const raw: ProjectPlan = {
    version: 2,
    revision: 1,
    status: "proposed",
    phase: "frontend",
    siteGoal: "temporary",
    audience: "temporary",
    pages: ["Overview", "Jobs"],
    features: ["Jobs"],
    sitemap: [
      { ...map.sitemap[0], componentIds: ["app-shell"] },
      { ...map.sitemap[1], componentIds: ["job-list"] },
    ],
    components: [
      { id: "app-shell", name: "App Shell", kind: "layout", purpose: "Shared shell", usedBy: ["overview", "jobs"], variants: [], acceptanceCriteria: ["shell works"] },
      { id: "job-list", name: "Job List", kind: "feature", purpose: "Show jobs", usedBy: ["jobs"], variants: [], acceptanceCriteria: ["jobs render"] },
    ],
    styles: concreteStyles,
    visualDirection: "temporary",
    backendRequired: true,
    slices: [
      { id: "jobs", title: "Jobs", outcome: "Jobs work", scope: ["app-shell", "job-list"], acceptanceCriteria: ["works"] },
      { id: "frontend-review", title: "Frontend review", outcome: "Review", scope: ["cross-page review"], acceptanceCriteria: ["passes"] },
    ],
    acceptanceCriteria: ["works"],
    proposedAt: now,
    approvedAt: null,
  };
  const plan = applyBlueprintFoundation(raw, map, concreteStyles);
  assert.equal(plan.slices[0]?.id, "visual-foundation");
  assert.equal(plan.sitemap[0]?.purpose, "See operations");
  assert.equal(plan.sitemap[1]?.componentIds[0], "job-list");
  assert.equal(plan.styles.colors[0], "canvas: #0B0D10");
  assert.deepEqual(plan.flows?.[0]?.steps, ["overview", "jobs"]);
  assert.equal(validateBlueprintCompletion(plan).valid, true);
});
