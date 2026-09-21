import type {
  ProjectPage,
  ProjectPlan,
  ProjectStyleSystem,
  ProjectUserFlow,
} from "../../core/src/project-domain.ts";
import { parseStructuredJson, structuredJsonArtifactBody } from "./structured-json.ts";

export type ProductMap = {
  siteGoal: string;
  audience: string;
  features: string[];
  sitemap: ProjectPage[];
  flows: ProjectUserFlow[];
  backendRequired: boolean;
};

export type BlueprintValidation = {
  valid: boolean;
  issues: string[];
};

export type BlueprintArtifactSource = "model" | "repaired" | "fallback";

export type ProductMapParseResult = {
  map: ProductMap;
  source: BlueprintArtifactSource;
  reason: string | null;
  issues: string[];
  candidate: ProductMap | null;
};

export type StyleSystemParseResult = {
  styles: ProjectStyleSystem;
  source: BlueprintArtifactSource;
  reason: string | null;
  issues: string[];
  candidate: ProjectStyleSystem | null;
};

function clean(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function list(value: unknown, fallback: string[] = []) {
  if (!Array.isArray(value)) return [...fallback];
  return value.map((item) => clean(item)).filter(Boolean);
}

function slug(value: string, index = 0) {
  const result = value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return result || `item-${index + 1}`;
}

function route(value: unknown, fallback: string) {
  const raw = clean(value, fallback);
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function uniqueRules(values: string[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fillRules(
  primary: string[],
  fallback: string[],
  minimum: number,
  concrete?: (value: string) => boolean,
  concreteMinimum = 0,
) {
  const merged = uniqueRules(primary);
  const hasEnough = () => merged.length >= minimum
    && (!concrete || merged.filter(concrete).length >= concreteMinimum);
  for (const item of fallback) {
    if (hasEnough()) break;
    if (!merged.some((value) => value.trim().toLowerCase() === item.trim().toLowerCase())) merged.push(item);
  }
  return merged;
}

function styleCandidate(raw: Record<string, unknown>): ProjectStyleSystem {
  return {
    direction: clean(raw.direction),
    colors: list(raw.colors),
    typography: list(raw.typography),
    spacing: list(raw.spacing),
    radii: list(raw.radii),
    shadows: list(raw.shadows),
    layoutPrinciples: list(raw.layoutPrinciples),
    motion: list(raw.motion),
    responsive: list(raw.responsive),
    accessibility: list(raw.accessibility),
    avoid: list(raw.avoid),
  };
}

function meaningfulStyleSignal(styles: ProjectStyleSystem) {
  return [
    styles.direction.trim(),
    ...styles.colors,
    ...styles.typography,
    ...styles.spacing,
    ...styles.radii,
    ...styles.shadows,
    ...styles.layoutPrinciples,
    ...styles.motion,
    ...styles.responsive,
    ...styles.accessibility,
    ...styles.avoid,
  ].filter((value) => value.trim()).length;
}

function hasMeaningfulStyleDecisions(styles: ProjectStyleSystem) {
  const concreteColor = /(?:#(?:[0-9a-f]{3}){1,2}\b|rgb\(|hsl\(|oklch\(|:\s*var\(|:\s*[a-z-]+-\d+)/i;
  const numeric = /\d/;
  const directionSpecific = styles.direction.trim().length >= 40;
  const concreteRules = [
    ...styles.colors.filter((item) => concreteColor.test(item)),
    ...styles.typography.filter((item) => numeric.test(item)),
    ...styles.spacing.filter((item) => numeric.test(item)),
    ...styles.motion.filter((item) => numeric.test(item)),
    ...styles.responsive.filter((item) => numeric.test(item)),
  ].length;
  const descriptiveRules = [
    ...styles.layoutPrinciples,
    ...styles.avoid,
  ].filter((item) => item.trim().length >= 24).length;
  return directionSpecific || concreteRules > 0 || descriptiveRules >= 2;
}

export function compileStyleSystem(candidate: ProjectStyleSystem, fallback: ProjectStyleSystem): { styles: ProjectStyleSystem; changes: string[] } {
  const changes: string[] = [];
  const colorConcrete = (item: string) => /(?:#(?:[0-9a-f]{3}){1,2}\b|rgb\(|hsl\(|oklch\(|:\s*var\(|:\s*[a-z-]+-\d+)/i.test(item);
  const numeric = (item: string) => /\d/.test(item);
  const fill = (
    key: keyof Omit<ProjectStyleSystem, "direction">,
    minimum: number,
    concrete?: (value: string) => boolean,
    concreteMinimum = 0,
  ) => {
    const source = candidate[key] as string[];
    const completed = fillRules(source, fallback[key] as string[], minimum, concrete, concreteMinimum);
    if (completed.length !== source.length || completed.some((value, index) => value !== source[index])) {
      changes.push(`completed ${String(key)} rules`);
    }
    return completed;
  };

  let direction = candidate.direction.trim();
  if (direction.length < 40) {
    direction = direction
      ? `${direction.replace(/[.\s]+$/, "")}. ${fallback.direction}`
      : fallback.direction;
    changes.push("completed visual direction");
  }

  return {
    styles: {
      direction,
      colors: fill("colors", 6, colorConcrete, 3),
      typography: fill("typography", 5, numeric, 3),
      spacing: fill("spacing", 5, numeric, 3),
      radii: fill("radii", 2),
      shadows: fill("shadows", 1),
      layoutPrinciples: fill("layoutPrinciples", 3),
      motion: fill("motion", 2),
      responsive: fill("responsive", 3),
      accessibility: fill("accessibility", 3),
      avoid: fill("avoid", 5),
    },
    changes,
  };
}

function repairReason(...parts: Array<string | null | undefined>) {
  const values = parts.map((part) => part?.trim()).filter(Boolean) as string[];
  return values.length ? values.join("; ") : null;
}

export function productMapPlanningPrompt(brief: string, feedback = "") {
  return `PROJECT BOOTSTRAP STAGE 1/3 — ROUGH PRODUCT MAP.

Create a lightweight route map that gives the project a coherent direction without designing the whole website up front. Do not propose React components, CSS, design tokens, acceptance criteria, or implementation details yet.

Produce:
- the site goal and target audience;
- the likely route/page sitemap in intended build order;
- a short purpose and a few rough section hints for each page;
- only the most important user journeys as page-id sequences;
- the product capabilities explicitly present in the brief;
- whether a backend phase will ultimately be required.

Rules:
- Every page needs a stable id and route.
- "/" must represent the primary entry page.
- Keep each page lightweight. Do not fully specify future pages before they are built.
- Do not invent backend features, commerce flows, or application screens that the brief does not request.
- Do not collapse a multi-page product into a generic "other pages" placeholder.
- Every flow step must reference a page id in the sitemap.
- Internal applications must not be converted into marketing-site architecture.

Return exactly one machine-readable block and nothing else.
Do not use markdown fences, commentary, or pseudo-JSON. The content inside the marker must be strict JSON accepted by JSON.parse: double-quoted keys/strings, no comments, no trailing commas.
<borg-product-map>{"siteGoal":"...","audience":"...","features":["..."],"sitemap":[{"id":"home","name":"Home","route":"/","purpose":"...","sections":["..."],"acceptanceCriteria":[]}],"flows":[{"id":"primary","name":"Primary journey","purpose":"...","steps":["home","detail"]}],"backendRequired":false}</borg-product-map>

Original brief:
${brief}${feedback.trim() ? `\n\nOperator blueprint feedback to incorporate:\n${feedback.trim()}` : ""}`;
}

export function parseProductMap(answer: string, fallback: ProjectPlan): ProductMapParseResult {
  const fallbackMap: ProductMap = {
    siteGoal: fallback.siteGoal,
    audience: fallback.audience,
    features: fallback.features,
    sitemap: fallback.sitemap.map((page) => ({ ...page, componentIds: [] })),
    flows: fallback.flows ?? fallbackFlows(fallback.sitemap),
    backendRequired: fallback.backendRequired,
  };
  const artifact = structuredJsonArtifactBody(answer, "borg-product-map");
  try {
    const parsedJson = parseStructuredJson<Record<string, unknown>>(artifact.body);
    const raw = parsedJson.value;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Product Map JSON root must be an object.");
    const rawPages = Array.isArray(raw.sitemap) ? raw.sitemap.slice(0, 40) : [];
    const productSignal = rawPages.length
      + (clean(raw.siteGoal) ? 1 : 0)
      + (clean(raw.audience) ? 1 : 0)
      + (Array.isArray(raw.features) && raw.features.length ? 1 : 0);
    if (productSignal < 2) {
      const issues = ["Product Map did not contain enough usable product decisions to normalize safely."];
      return { map: fallbackMap, source: "fallback", reason: issues[0], issues, candidate: null };
    }
    const sitemap = rawPages.map((item, index) => {
      const value = item as Record<string, unknown>;
      const name = clean(value.name, `Page ${index + 1}`);
      const id = slug(clean(value.id, name), index);
      return {
        id,
        name,
        route: route(value.route, index === 0 ? "/" : `/${id}`),
        purpose: clean(value.purpose, `${name} product surface.`),
        sections: list(value.sections, ["Primary content"]),
        componentIds: [],
        acceptanceCriteria: list(value.acceptanceCriteria, ["Page purpose is materially represented.", "Responsive behavior is intentional."]),
      };
    });
    const pageIds = new Set(sitemap.map((page) => page.id));
    const flows = (Array.isArray(raw.flows) ? raw.flows.slice(0, 20) : []).map((item, index) => {
      const value = item as Record<string, unknown>;
      const name = clean(value.name, `Journey ${index + 1}`);
      return {
        id: slug(clean(value.id, name), index),
        name,
        purpose: clean(value.purpose, `${name} user journey.`),
        steps: list(value.steps).map((step, stepIndex) => slug(step, stepIndex)).filter((step) => pageIds.has(step)),
      };
    }).filter((flow) => flow.steps.length >= 2);
    const candidate: ProductMap = {
      siteGoal: clean(raw.siteGoal, fallbackMap.siteGoal),
      audience: clean(raw.audience, fallbackMap.audience),
      features: list(raw.features, fallbackMap.features),
      sitemap: sitemap.length ? sitemap : fallbackMap.sitemap,
      flows: flows.length ? flows : fallbackFlows(sitemap.length ? sitemap : fallbackMap.sitemap),
      backendRequired: typeof raw.backendRequired === "boolean" ? raw.backendRequired : fallbackMap.backendRequired,
    };
    const validation = validateProductMap(candidate);
    const framingRepair = artifact.framed ? null : artifact.framingRepair;
    const reason = repairReason(framingRepair, parsedJson.repairSummary);
    if (!validation.valid) {
      return {
        map: fallbackMap,
        source: "fallback",
        reason: validation.issues.join(" "),
        issues: validation.issues,
        candidate,
      };
    }
    return {
      map: candidate,
      source: reason ? "repaired" : "model",
      reason,
      issues: [],
      candidate,
    };
  } catch (error) {
    const message = `Product map could not be parsed: ${error instanceof Error ? error.message : String(error)}`;
    return { map: fallbackMap, source: "fallback", reason: message, issues: [message], candidate: null };
  }
}

export function fallbackFlows(sitemap: ProjectPage[]): ProjectUserFlow[] {
  if (sitemap.length < 2) return [];
  const primary = sitemap.slice(0, Math.min(5, sitemap.length)).map((page) => page.id);
  return [{
    id: "primary-journey",
    name: "Primary journey",
    purpose: "Connect the primary entry surface to the most important downstream product surfaces.",
    steps: primary,
  }];
}

export function validateProductMap(map: ProductMap): BlueprintValidation {
  const issues: string[] = [];
  if (!map.sitemap.length) issues.push("Sitemap is empty.");
  const ids = map.sitemap.map((page) => page.id);
  const routes = map.sitemap.map((page) => page.route);
  if (new Set(ids).size !== ids.length) issues.push("Sitemap contains duplicate page ids.");
  if (new Set(routes).size !== routes.length) issues.push("Sitemap contains duplicate routes.");
  if (!map.sitemap.some((page) => page.route === "/")) issues.push("Sitemap has no primary '/' route.");
  for (const page of map.sitemap) {
    if (!page.sections.length) issues.push(`${page.name} has no ordered sections.`);
  }
  const known = new Set(ids);
  if (map.sitemap.length > 1 && !map.flows.length) issues.push("Multi-page product has no user journeys.");
  for (const flow of map.flows) {
    if (flow.steps.length < 2) issues.push(`Flow ${flow.name} has fewer than two steps.`);
    for (const step of flow.steps) if (!known.has(step)) issues.push(`Flow ${flow.name} references unknown page "${step}".`);
  }
  return { valid: issues.length === 0, issues };
}

export function validateProductMapIntent(map: ProductMap, brief: string): BlueprintValidation {
  const corpus = [
    map.siteGoal,
    map.audience,
    ...map.features,
    ...map.sitemap.flatMap((page) => [page.name, page.route, page.purpose, ...page.sections]),
  ].join(" ").toLowerCase();
  const briefText = brief.toLowerCase();
  const travelBrief = /\b(?:adventure|expedition|travel|traveler|destination|itinerary|field notes|retreat|hospitality)\b/.test(briefText);
  const commerceMarkers = (corpus.match(/\b(?:cart|checkout|order|seller|catalog|merchandise|sku|variant|product purchase|marketplace)\b/g) ?? []).length;
  if (travelBrief && commerceMarkers >= 2) {
    return {
      valid: false,
      issues: ["Product Map conflicts with the travel/expedition brief: it introduces commerce purchase architecture instead of the requested editorial journey."],
    };
  }
  return { valid: true, issues: [] };
}

export function validateStyleSystemIntent(styles: ProjectStyleSystem, brief: string): BlueprintValidation {
  const briefText = brief.toLowerCase();
  const styleText = [styles.direction, ...styles.colors, ...styles.layoutPrinciples, ...styles.avoid].join(" ").toLowerCase();
  const excludesCommerce = /\b(?:do\s+not|don't|without|avoid|no)\b[^.\n]{0,80}\b(?:e.?commerce|store|shop|cart|checkout|marketplace|product purchase)\b/i.test(briefText);
  const commerceMarkers = (styleText.match(/\b(?:commerce|marketplace|product imagery|discovery|purchase|cart|checkout|seller|catalog)\b/g) ?? []).length;
  if (excludesCommerce && commerceMarkers >= 2) {
    return {
      valid: false,
      issues: ["Global style system conflicts with the brief's explicit exclusion of commerce architecture."],
    };
  }
  return { valid: true, issues: [] };
}

export function styleSystemPlanningPrompt(input: {
  brief: string;
  map: ProductMap;
  designBrief: unknown;
  feedback?: string;
}) {
  return `PROJECT BLUEPRINT STAGE 2/4 — GLOBAL DESIGN SYSTEM.

The product map below is already established. Build an implementation-grade visual foundation BEFORE component architecture is designed. Do not create application components or implementation slices.

The output must be specific enough that an Implementer can create shared tokens/primitives without inventing visual rules while coding features.

Requirements:
- Colors: at least 6 semantic roles with concrete values or explicit token assignments.
- Typography: at least 5 roles with size/line-height/weight/tracking guidance.
- Spacing: define a reusable numeric/token scale plus page/section/component rhythm.
- Radii and shadows: define small deliberate scales, not "use consistent radii".
- Layout: define content widths, gutters, grid/alignment principles, and density.
- Motion: define duration/easing/use rules and reduced-motion behavior.
- Responsive: define real recomposition rules, not only "stack on mobile".
- Accessibility: focus, contrast, target-size and non-color meaning rules.
- Avoid: at least 5 explicit anti-patterns.

Return exactly one machine-readable block and nothing else.
Do not use markdown fences, commentary, or pseudo-JSON. The content inside the marker must be strict JSON accepted by JSON.parse: double-quoted keys/strings, no comments, no trailing commas.
<borg-style-system>{"direction":"...","colors":["canvas: #..."],"typography":["display-xl: 48/52 ..."],"spacing":["space-1: 4px"],"radii":["radius-sm: 6px"],"shadows":["..."],"layoutPrinciples":["..."],"motion":["..."],"responsive":["..."],"accessibility":["..."],"avoid":["..."]}</borg-style-system>

Original brief:
${input.brief}

Frozen product map:
${JSON.stringify(input.map, null, 2)}

Approved Design Director brief:
${JSON.stringify(input.designBrief, null, 2)}
${input.feedback?.trim() ? `\nOperator blueprint feedback:\n${input.feedback.trim()}` : ""}`;
}

export function parseStyleSystem(answer: string, fallback: ProjectStyleSystem): StyleSystemParseResult {
  const artifact = structuredJsonArtifactBody(answer, "borg-style-system");
  try {
    const parsedJson = parseStructuredJson<Record<string, unknown>>(artifact.body);
    if (!parsedJson.value || typeof parsedJson.value !== "object" || Array.isArray(parsedJson.value)) {
      throw new Error("Design System JSON root must be an object.");
    }
    const candidate = styleCandidate(parsedJson.value);
    if (meaningfulStyleSignal(candidate) < 2 || !hasMeaningfulStyleDecisions(candidate)) {
      const issues = ["Design system did not contain enough concrete creative decisions to compile safely."];
      return {
        styles: fallback,
        source: "fallback",
        reason: issues[0],
        issues,
        candidate,
      };
    }

    const compiled = compileStyleSystem(candidate, fallback);
    const validation = validateStyleSystem(compiled.styles);
    const reason = repairReason(
      artifact.framed ? null : artifact.framingRepair,
      parsedJson.repairSummary,
      compiled.changes.length ? compiled.changes.join(", ") : null,
    );
    if (!validation.valid) {
      return {
        styles: fallback,
        source: "fallback",
        reason: validation.issues.join(" "),
        issues: validation.issues,
        candidate: compiled.styles,
      };
    }
    return {
      styles: compiled.styles,
      source: reason ? "repaired" : "model",
      reason,
      issues: [],
      candidate: compiled.styles,
    };
  } catch (error) {
    const message = `Style system could not be parsed: ${error instanceof Error ? error.message : String(error)}`;
    return { styles: fallback, source: "fallback", reason: message, issues: [message], candidate: null };
  }
}

export function styleSystemAugmentationPrompt(input: { candidate: ProjectStyleSystem | null; issues: string[] }) {
  return [
    "PROJECT BLUEPRINT DESIGN-SYSTEM AUGMENTATION.",
    "The existing design direction is authoritative. Supply only the missing or weak design-system decisions listed below; do not redesign the site, replace valid decisions, or discuss implementation.",
    `Missing or weak requirements:\n- ${input.issues.join("\n- ")}`,
    `Current partial design system:\n${JSON.stringify(input.candidate ?? {}, null, 2)}`,
    "Return only a JSON object containing fields that need augmentation. You may use these keys: direction, colors, typography, spacing, radii, shadows, layoutPrinciples, motion, responsive, accessibility, avoid.",
    '<borg-style-augmentation>{"colors":["border: #..."],"typography":["..."]}</borg-style-augmentation>',
  ].join("\n\n");
}

export function applyStyleSystemAugmentation(
  current: ProjectStyleSystem | null,
  answer: string,
  fallback: ProjectStyleSystem,
): StyleSystemParseResult {
  const base = current ?? {
    direction: "",
    colors: [],
    typography: [],
    spacing: [],
    radii: [],
    shadows: [],
    layoutPrinciples: [],
    motion: [],
    responsive: [],
    accessibility: [],
    avoid: [],
  };
  const artifact = structuredJsonArtifactBody(answer, "borg-style-augmentation");
  if (!artifact.body.trim()) {
    const preserved = compileStyleSystem(base, fallback).styles;
    return {
      styles: preserved,
      source: "repaired",
      reason: "No design-system augmentation provided; preserved the existing design system.",
      issues: [],
      candidate: preserved,
    };
  }
  try {
    const parsedJson = parseStructuredJson<Record<string, unknown>>(artifact.body);
    const raw = parsedJson.value;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Design-system augmentation JSON root must be an object.");
    const merge = (key: keyof Omit<ProjectStyleSystem, "direction">) =>
      uniqueRules([...(base[key] as string[]), ...list(raw[key])]);
    const augmented: ProjectStyleSystem = {
      direction: clean(raw.direction, base.direction),
      colors: merge("colors"),
      typography: merge("typography"),
      spacing: merge("spacing"),
      radii: merge("radii"),
      shadows: merge("shadows"),
      layoutPrinciples: merge("layoutPrinciples"),
      motion: merge("motion"),
      responsive: merge("responsive"),
      accessibility: merge("accessibility"),
      avoid: merge("avoid"),
    };
    const compiled = compileStyleSystem(augmented, fallback);
    const validation = validateStyleSystem(compiled.styles);
    const reason = repairReason(
      "augmented missing design-system decisions",
      artifact.framed ? null : artifact.framingRepair,
      parsedJson.repairSummary,
      compiled.changes.length ? compiled.changes.join(", ") : null,
    );
    if (!validation.valid) {
      return {
        styles: fallback,
        source: "fallback",
        reason: validation.issues.join(" "),
        issues: validation.issues,
        candidate: compiled.styles,
      };
    }
    return {
      styles: compiled.styles,
      source: "repaired",
      reason,
      issues: [],
      candidate: compiled.styles,
    };
  } catch (error) {
    const message = `Design-system augmentation could not be parsed: ${error instanceof Error ? error.message : String(error)}`;
    return { styles: fallback, source: "fallback", reason: message, issues: [message], candidate: base };
  }
}

export function validateStyleSystem(styles: ProjectStyleSystem): BlueprintValidation {
  const issues: string[] = [];
  if (styles.direction.trim().length < 40) issues.push("Visual direction is too vague.");
  const required: Array<[keyof ProjectStyleSystem, number]> = [
    ["colors", 6], ["typography", 5], ["spacing", 5], ["radii", 2], ["shadows", 1],
    ["layoutPrinciples", 3], ["motion", 2], ["responsive", 3], ["accessibility", 3], ["avoid", 5],
  ];
  for (const [key, minimum] of required) {
    const value = styles[key];
    if (!Array.isArray(value) || value.length < minimum) issues.push(`${String(key)} needs at least ${minimum} concrete rules.`);
  }
  const concreteColors = styles.colors.filter((item) => /(?:#(?:[0-9a-f]{3}){1,2}\b|rgb\(|hsl\(|oklch\(|:\s*var\(|:\s*[a-z-]+-\d+)/i.test(item)).length;
  if (concreteColors < 3) issues.push("Color system lacks concrete semantic token/value assignments.");
  const numericType = styles.typography.filter((item) => /\d/.test(item)).length;
  if (numericType < 3) issues.push("Typography system lacks concrete scale metrics.");
  const numericSpacing = styles.spacing.filter((item) => /\d/.test(item)).length;
  if (numericSpacing < 3) issues.push("Spacing system lacks a concrete reusable scale.");
  return { valid: issues.length === 0, issues };
}

export function blueprintCompletionPrompt(input: {
  brief: string;
  map: ProductMap;
  styles: ProjectStyleSystem;
  feedback?: string;
}) {
  return `PROJECT BOOTSTRAP STAGE 3/3 — PAGE QUEUE.

The ROUGH PRODUCT MAP and GLOBAL STYLE SYSTEM below are frozen project-level authority. Create only the ordered page queue needed to begin progressive implementation. Detailed page composition, components, interactions, and page acceptance criteria belong to the active page slice, not this outer plan.

Do not silently replace routes, page purposes, user flows, or global style rules. Keep every page's componentIds empty until that page is planned and built.

PROGRESSIVE PAGE QUEUE:
- create one bounded implementation slice per major page or coherent page group, in build order;
- Slice 1 must focus on the homepage/primary entry route and establish only the shared primitives it actually needs;
- include a final frontend completion review slice after the page queue;
- do not create hypothetical future components or detailed acceptance criteria for pages not yet active;
- components must be an empty array in this outer plan unless an already-built registry component is explicitly being reused.

Return exactly one complete <borg-project-plan> block and nothing else. Do not use markdown fences or commentary. The content inside the marker must be strict JSON accepted by JSON.parse: double-quoted keys/strings, no comments, no trailing commas. Use the frozen sitemap fields exactly and keep componentIds and page acceptanceCriteria empty. Include the frozen style system exactly. Include the frozen user flows exactly.

Frozen product map:
${JSON.stringify(input.map, null, 2)}

Frozen style system:
${JSON.stringify(input.styles, null, 2)}

Original brief:
${input.brief}
${input.feedback?.trim() ? `\nOperator blueprint feedback:\n${input.feedback.trim()}` : ""}`;
}

export function applyBlueprintFoundation(plan: ProjectPlan, map: ProductMap, styles: ProjectStyleSystem): ProjectPlan {
  const sitemap = map.sitemap.map((page) => ({
    ...page,
    componentIds: [],
    acceptanceCriteria: [],
  }));
  return {
    ...plan,
    siteGoal: map.siteGoal,
    audience: map.audience,
    pages: sitemap.map((page) => page.name),
    features: map.features,
    sitemap,
    flows: map.flows,
    styles,
    visualDirection: styles.direction,
    backendRequired: map.backendRequired,
    components: [],
    slices: plan.slices,
  };
}

export function validateBlueprintCompletion(plan: ProjectPlan): BlueprintValidation {
  const issues = [...validateProductMap({
    siteGoal: plan.siteGoal,
    audience: plan.audience,
    features: plan.features,
    sitemap: plan.sitemap,
    flows: plan.flows ?? [],
    backendRequired: plan.backendRequired,
  }).issues, ...validateStyleSystem(plan.styles).issues];

  if (!plan.slices.length) issues.push("Progressive blueprint has no page implementation queue.");
  if (plan.components.length) issues.push("Outer blueprint must not invent a complete component inventory before page implementation.");
  if (plan.sitemap.some((page) => page.componentIds.length || page.acceptanceCriteria.length)) {
    issues.push("Outer blueprint pages must remain lightweight until their page slices are planned.");
  }
  return { valid: issues.length === 0, issues };
}
