import test from "node:test";
import assert from "node:assert/strict";
import {
  applyBlueprintFoundation,
  applyStyleSystemAugmentation,
  parseProductMap,
  parseStyleSystem,
  validateBlueprintCompletion,
  validateProductMap,
  validateProductMapIntent,
  validateStyleSystemIntent,
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

test("product-map stage accepts valid raw JSON when the framing marker is missing", () => {
  const fallback = fallbackProjectPlan("Build a premium expedition website", "portfolio");
  const answer = JSON.stringify({
    siteGoal: "Guide travelers toward premium expeditions",
    audience: "Design-conscious adventure travelers",
    features: ["Expedition discovery", "Editorial journal", "Inquiry"],
    sitemap: [
      { id: "home", name: "Home", route: "/", purpose: "Introduce Driftline", sections: ["Hero", "Selected expeditions"], acceptanceCriteria: ["Primary journeys are visible"] },
      { id: "expeditions", name: "Expeditions", route: "/expeditions", purpose: "Browse trips", sections: ["Filters", "Results"], acceptanceCriteria: ["Travelers can discover trips"] },
    ],
    flows: [{ id: "discover", name: "Discover", purpose: "Move from brand entry to trip discovery", steps: ["home", "expeditions"] }],
    backendRequired: false,
  });
  const result = parseProductMap(answer, fallback);
  assert.equal(result.source, "repaired");
  assert.match(result.reason ?? "", /without <borg-product-map> framing/i);
  assert.equal(result.map.sitemap.length, 2);
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

test("product-map intent rejects commerce architecture for an expedition brief", () => {
  const fallback = fallbackProjectPlan("Build a premium expedition portfolio", "portfolio");
  const commerceMap = {
    siteGoal: "Drive product discovery and purchase",
    audience: "Travel shoppers",
    features: ["Catalog", "Cart", "Checkout"],
    sitemap: fallback.sitemap.map((page) => ({ ...page, name: page.name, sections: ["Product catalog", "Cart", "Checkout"] })),
    flows: fallback.flows ?? [],
    backendRequired: false,
  };
  const result = validateProductMapIntent(commerceMap, "Build a premium adventure travel website with editorial expeditions and field notes.");
  assert.equal(result.valid, false);
  assert.match(result.issues[0] ?? "", /travel\/expedition brief/i);
});

test("style-system intent rejects stale commerce direction for an excluded-commerce brief", () => {
  const result = validateStyleSystemIntent({
    ...concreteStyles,
    direction: "Premium mobile-first commerce with strong product imagery and trustworthy purchase flows.",
  }, "Build a frontend-only portfolio website. Do not add ecommerce, cart, checkout, or backend features.");
  assert.equal(result.valid, false);
  assert.match(result.issues[0] ?? "", /commerce architecture/i);
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

test("style-system compiler completes an under-specified but meaningful model direction", () => {
  const fallback = fallbackProjectPlan("Build a premium expedition portfolio", "portfolio").styles;
  const partial = JSON.stringify({
    direction: "Cinematic expedition editorial with dark mineral surfaces and warm field-note accents",
    colors: ["canvas: #10110F", "accent: #C9793A"],
    typography: ["display: 64px/66px weight 600"],
    spacing: ["section-gap: 96px"],
    layoutPrinciples: ["Use expansive photography against narrow editorial text columns"],
    avoid: ["generic card grids"],
  });
  const parsed = parseStyleSystem(partial, fallback);
  assert.equal(parsed.source, "repaired");
  assert.equal(validateStyleSystem(parsed.styles).valid, true);
  assert.equal(parsed.styles.colors[0], "canvas: #10110F");
  assert.ok(parsed.styles.colors.length >= 6);
  assert.ok(parsed.styles.typography.length >= 5);
  assert.match(parsed.reason ?? "", /completed .*rules|without <borg-style-system> framing/i);
});

test("targeted design-system augmentation merges only missing decisions before compilation", () => {
  const fallback = fallbackProjectPlan("Build a premium expedition portfolio", "portfolio").styles;
  const initial = parseStyleSystem('{"direction":"Cinematic expedition editorial"}', fallback);
  assert.equal(initial.source, "fallback");
  const augmented = applyStyleSystemAugmentation(
    initial.candidate,
    '<borg-style-augmentation>{"colors":["canvas: #10110F","accent: #C9793A"],"typography":["display: 64px/66px weight 600"],"layoutPrinciples":["Expansive photographic fields with narrow reading columns"]}</borg-style-augmentation>',
    fallback,
  );
  assert.equal(augmented.source, "repaired");
  assert.equal(validateStyleSystem(augmented.styles).valid, true);
  assert.ok(augmented.styles.colors.includes("accent: #C9793A"));
  assert.match(augmented.reason ?? "", /augmented missing design-system decisions/i);
});

test("style-system parser deterministically repairs malformed JSON without weakening style validation", () => {
  const fallback = fallbackProjectPlan("Build a premium editorial site", "portfolio").styles;
  const malformed = JSON.stringify(concreteStyles).replace('"surface: #12161C","raised: #181E27"', '"surface: #12161C" "raised: #181E27"');
  const parsed = parseStyleSystem(`<borg-style-system>${malformed}</borg-style-system>`, fallback);
  assert.equal(parsed.source, "repaired");
  assert.equal(validateStyleSystem(parsed.styles).valid, true);
  assert.match(parsed.reason ?? "", /missing comma/i);
});

test("empty style-system augmentation preserves the existing valid design system instead of failing", () => {
  const fallback = fallbackProjectPlan("Build a premium expedition portfolio", "portfolio").styles;
  const result = applyStyleSystemAugmentation(concreteStyles, "    ", fallback);
  assert.equal(result.source, "repaired");
  assert.equal(validateStyleSystem(result.styles).valid, true);
  assert.deepEqual(result.styles, concreteStyles);
  assert.match(result.reason ?? "", /empty|preserve/i);
});

test("blueprint completion keeps page and component detail deferred to page slices", () => {
  const plan: ProjectPlan = {
    version: 2,
    revision: 1,
    status: "proposed",
    phase: "frontend",
    siteGoal: "Guide travelers to premium expeditions",
    audience: "Adventure travelers",
    pages: ["Home", "Expeditions", "Journal", "About", "Inquiry"],
    features: ["Expedition discovery", "Editorial journal", "Inquiry"],
    sitemap: [
      { id: "home", name: "Home", route: "/", purpose: "Introduce Driftline and the expedition promise", sections: ["Navigation", "Hero", "Selected expeditions"], componentIds: [], acceptanceCriteria: [] },
      { id: "expeditions", name: "Expeditions", route: "/expeditions", purpose: "Browse destination-specific trips", sections: ["Filters", "Results"], componentIds: [], acceptanceCriteria: [] },
      { id: "journal", name: "Journal", route: "/journal", purpose: "Read editorial stories and field notes", sections: ["Featured article", "List"], componentIds: [], acceptanceCriteria: [] },
      { id: "about", name: "About", route: "/about", purpose: "Explain the field philosophy", sections: ["Story", "Guides"], componentIds: [], acceptanceCriteria: [] },
      { id: "inquiry", name: "Inquiry", route: "/inquiry", purpose: "Begin a premium trip inquiry", sections: ["Form"], componentIds: [], acceptanceCriteria: [] },
    ],
    flows: [{ id: "discover", name: "Discover", purpose: "Move from brand entry to expedition discovery and inquiry", steps: ["home", "expeditions", "inquiry"] }],
    components: [],
    styles: concreteStyles,
    visualDirection: "Cinematic expedition editorial with dark mineral surfaces and warm field-note accents",
    backendRequired: false,
    slices: [
      { id: "home", title: "Homepage", outcome: "The expedition homepage establishes the visual language and primary journey.", scope: ["Home", "homepage composition"], acceptanceCriteria: ["home works"] },
      { id: "expeditions", title: "Expeditions", outcome: "The expedition discovery page is navigable and coherent.", scope: ["Expeditions", "discovery page"], acceptanceCriteria: ["expeditions work"] },
      { id: "frontend-review", title: "Frontend completion review", outcome: "Review the complete expedition experience.", scope: ["responsive review", "accessibility review"], acceptanceCriteria: ["passes"] },
    ],
    acceptanceCriteria: ["The premium expedition experience is navigable."],
    proposedAt: new Date().toISOString(),
    approvedAt: null,
  };
  assert.equal(validateBlueprintCompletion(plan).valid, true);
});

test("blueprint completion freezes map/styles without inventing a foundation slice", () => {
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
  assert.equal(plan.slices[0]?.id, "jobs");
  assert.equal(plan.sitemap[0]?.purpose, "See operations");
  assert.deepEqual(plan.sitemap.map((page) => page.componentIds), [[], []]);
  assert.equal(plan.styles.colors[0], "canvas: #0B0D10");
  assert.deepEqual(plan.components, []);
  assert.deepEqual(plan.sitemap.map((page) => page.componentIds), [[], []]);
  assert.deepEqual(plan.flows?.[0]?.steps, ["overview", "jobs"]);
  assert.equal(validateBlueprintCompletion(plan).valid, true);
});
