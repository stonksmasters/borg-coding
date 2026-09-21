import type {
  ProjectPage,
  ProjectPlan,
  ProjectStyleSystem,
  ProjectUserFlow,
} from "../../core/src/project-domain.ts";

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

const productMapMarker = /<borg-product-map>([\s\S]*?)<\/borg-product-map>/i;
const styleMarker = /<borg-style-system>([\s\S]*?)<\/borg-style-system>/i;

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

export function productMapPlanningPrompt(brief: string, feedback = "") {
  return `PROJECT BLUEPRINT STAGE 1/4 — PRODUCT MAP.

Map the complete product before designing components or implementation slices. Do not propose React components, CSS, design tokens, or code yet.

Produce:
- the site goal and target audience;
- the complete route/page sitemap;
- the ordered sections and page-level acceptance criteria for every page;
- the important user journeys as page-id sequences;
- the product capabilities required by the brief;
- whether a backend phase will ultimately be required.

Rules:
- Every page needs a stable id and route.
- "/" must represent the primary entry page.
- Do not collapse a multi-page product into a generic "other pages" placeholder.
- Every flow step must reference a page id in the sitemap.
- Include product/application routes even when the original brief only describes the capability.
- Internal applications must not be converted into marketing-site architecture.

Return exactly one machine-readable block and nothing else.
Do not use markdown fences, commentary, or pseudo-JSON. The content inside the marker must be strict JSON accepted by JSON.parse: double-quoted keys/strings, no comments, no trailing commas.
<borg-product-map>{"siteGoal":"...","audience":"...","features":["..."],"sitemap":[{"id":"home","name":"Home","route":"/","purpose":"...","sections":["..."],"acceptanceCriteria":["..."]}],"flows":[{"id":"primary","name":"Primary journey","purpose":"...","steps":["home","detail"]}],"backendRequired":false}</borg-product-map>

Original brief:
${brief}${feedback.trim() ? `\n\nOperator blueprint feedback to incorporate:\n${feedback.trim()}` : ""}`;
}

export function parseProductMap(answer: string, fallback: ProjectPlan): { map: ProductMap; source: "model" | "fallback"; reason: string | null } {
  const fallbackMap: ProductMap = {
    siteGoal: fallback.siteGoal,
    audience: fallback.audience,
    features: fallback.features,
    sitemap: fallback.sitemap.map((page) => ({ ...page, componentIds: [] })),
    flows: fallback.flows ?? fallbackFlows(fallback.sitemap),
    backendRequired: fallback.backendRequired,
  };
  const match = answer.match(productMapMarker);
  if (!match) return { map: fallbackMap, source: "fallback", reason: "Product-map marker was missing." };
  try {
    const raw = JSON.parse(match[1]) as Record<string, unknown>;
    const rawPages = Array.isArray(raw.sitemap) ? raw.sitemap.slice(0, 40) : [];
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
    const map: ProductMap = {
      siteGoal: clean(raw.siteGoal, fallbackMap.siteGoal),
      audience: clean(raw.audience, fallbackMap.audience),
      features: list(raw.features, fallbackMap.features),
      sitemap: sitemap.length ? sitemap : fallbackMap.sitemap,
      flows: flows.length ? flows : fallbackFlows(sitemap.length ? sitemap : fallbackMap.sitemap),
      backendRequired: typeof raw.backendRequired === "boolean" ? raw.backendRequired : fallbackMap.backendRequired,
    };
    const validation = validateProductMap(map);
    return validation.valid
      ? { map, source: "model", reason: null }
      : { map: fallbackMap, source: "fallback", reason: validation.issues.join(" ") };
  } catch (error) {
    return { map: fallbackMap, source: "fallback", reason: `Product map could not be parsed: ${error instanceof Error ? error.message : String(error)}` };
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
    if (!page.acceptanceCriteria.length) issues.push(`${page.name} has no acceptance criteria.`);
  }
  const known = new Set(ids);
  if (map.sitemap.length > 1 && !map.flows.length) issues.push("Multi-page product has no user journeys.");
  for (const flow of map.flows) {
    if (flow.steps.length < 2) issues.push(`Flow ${flow.name} has fewer than two steps.`);
    for (const step of flow.steps) if (!known.has(step)) issues.push(`Flow ${flow.name} references unknown page "${step}".`);
  }
  return { valid: issues.length === 0, issues };
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

export function parseStyleSystem(answer: string, fallback: ProjectStyleSystem): { styles: ProjectStyleSystem; source: "model" | "fallback"; reason: string | null } {
  const match = answer.match(styleMarker);
  if (!match) return { styles: fallback, source: "fallback", reason: "Style-system marker was missing." };
  try {
    const raw = JSON.parse(match[1]) as Record<string, unknown>;
    const styles: ProjectStyleSystem = {
      direction: clean(raw.direction, fallback.direction),
      colors: list(raw.colors, fallback.colors),
      typography: list(raw.typography, fallback.typography),
      spacing: list(raw.spacing, fallback.spacing),
      radii: list(raw.radii, fallback.radii),
      shadows: list(raw.shadows, fallback.shadows),
      layoutPrinciples: list(raw.layoutPrinciples, fallback.layoutPrinciples),
      motion: list(raw.motion, fallback.motion),
      responsive: list(raw.responsive, fallback.responsive),
      accessibility: list(raw.accessibility, fallback.accessibility),
      avoid: list(raw.avoid, fallback.avoid),
    };
    const validation = validateStyleSystem(styles);
    return validation.valid
      ? { styles, source: "model", reason: null }
      : { styles: fallback, source: "fallback", reason: validation.issues.join(" ") };
  } catch (error) {
    return { styles: fallback, source: "fallback", reason: `Style system could not be parsed: ${error instanceof Error ? error.message : String(error)}` };
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
  return `PROJECT BLUEPRINT STAGES 3-4/4 — COMPONENT ARCHITECTURE AND BUILD ROADMAP.

The PRODUCT MAP and GLOBAL STYLE SYSTEM below are frozen foundation artifacts. Derive the reusable component architecture from them, then derive implementation slices from the resulting page/component graph.

Do not silently replace routes, page purposes, user flows, or global style rules. You may assign componentIds to frozen pages.

COMPONENT ARCHITECTURE:
- enumerate shared layout, section, UI, and feature components needed by the sitemap;
- every component has stable id, kind, purpose, usedBy page ids, variants, and acceptance criteria;
- prefer shared primitives when roles genuinely repeat, but do not force unrelated sections into generic cards.

BUILD ROADMAP:
- Slice 1 MUST be "Visual foundation and shared primitives" (or an equivalently named foundation slice) and establish theme/tokens, typography, spacing, layout primitives, focus/motion rules, base controls, and the application shell BEFORE product-specific component slices.
- later slices implement concrete page/component outcomes;
- every planned component must appear in at least one slice scope;
- include a final cross-page frontend completion review slice.

Return exactly one complete <borg-project-plan> block and nothing else. Do not use markdown fences or commentary. The content inside the marker must be strict JSON accepted by JSON.parse: double-quoted keys/strings, no comments, no trailing commas. Use the frozen sitemap fields exactly except componentIds. Include the frozen style system exactly. Include the frozen user flows exactly.

Frozen product map:
${JSON.stringify(input.map, null, 2)}

Frozen style system:
${JSON.stringify(input.styles, null, 2)}

Original brief:
${input.brief}
${input.feedback?.trim() ? `\nOperator blueprint feedback:\n${input.feedback.trim()}` : ""}`;
}

export function applyBlueprintFoundation(plan: ProjectPlan, map: ProductMap, styles: ProjectStyleSystem): ProjectPlan {
  const finalPages = new Map(plan.sitemap.map((page) => [page.id, page]));
  const sitemap = map.sitemap.map((page) => ({
    ...page,
    componentIds: finalPages.get(page.id)?.componentIds ?? [],
  }));
  const first = plan.slices[0];
  const alreadyFoundation = first && /foundation|design system|tokens|shared primitives/i.test([first.id, first.title, ...first.scope].join(" "));
  const foundation = {
    id: "visual-foundation",
    title: "Visual foundation and shared primitives",
    outcome: "The approved global design system is implemented as reusable theme, layout, interaction, responsive, and accessibility primitives before product-specific UI is built.",
    scope: [
      "global color tokens",
      "typography roles and scale",
      "spacing and layout primitives",
      "radii, elevation, focus, and motion primitives",
      "responsive gutters and content widths",
      "base controls and application shell",
    ],
    acceptanceCriteria: [
      "shared visual tokens are implemented centrally rather than repeated as one-off component values",
      "typography and spacing roles visibly establish hierarchy and rhythm",
      "desktop and mobile shell/layout primitives follow the approved responsive rules",
      "focus, contrast, and reduced-motion foundations are present before feature components are built",
    ],
  };
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
    slices: alreadyFoundation ? plan.slices : [foundation, ...plan.slices],
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

  const pageIds = new Set(plan.sitemap.map((page) => page.id));
  const componentIds = new Set(plan.components.map((component) => component.id));
  for (const page of plan.sitemap) for (const componentId of page.componentIds) {
    if (!componentIds.has(componentId)) issues.push(`${page.name} references unknown component "${componentId}".`);
  }
  for (const component of plan.components) for (const pageId of component.usedBy) {
    if (!pageIds.has(pageId)) issues.push(`${component.name} references unknown page "${pageId}".`);
  }
  const first = plan.slices[0];
  if (!first || !/foundation|design system|tokens|shared primitives/i.test([first.id, first.title, ...first.scope].join(" "))) {
    issues.push("The first implementation slice is not a visual foundation/shared-primitives slice.");
  }
  const sliceText = plan.slices.map((slice) => [slice.title, slice.outcome, ...slice.scope].join(" ").toLowerCase()).join("\n");
  for (const component of plan.components) {
    if (!sliceText.includes(component.name.toLowerCase()) && !sliceText.includes(component.id.toLowerCase())) {
      issues.push(`Component "${component.name}" is not assigned to any implementation slice.`);
    }
  }
  return { valid: issues.length === 0, issues };
}
