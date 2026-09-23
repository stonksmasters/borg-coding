import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync as writeRawFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { WorkflowState } from "../../core/src/contracts.ts";
import type { ProjectComponent, ProjectPage, ProjectPlan, ProjectSlice, ProjectStyleSystem } from "../../core/src/project-domain.ts";
import { applyBlueprintFoundation, briefForcesFrontendOnly, fallbackFlows, normalizeStyleDirection, type ProductMap } from "./blueprint-planning.ts";
import { initializeProjectModel } from "./project-model.ts";
import { parseStructuredJson, structuredJsonArtifactBody } from "./structured-json.ts";

export type SliceAction = "initial" | "revise" | "advance";
export type { ProjectPlan, ProjectSlice, ProjectStyleSystem };
export type ProjectSitemapPage = ProjectPage;
export type PlannedComponent = ProjectComponent;
export type SliceState = {
  version: 2;
  current: number;
  total: number;
  currentTitle: string;
  status: "plan_pending" | "ready" | "working" | "awaiting_feedback" | "frontend_complete";
  brief: string;
  lastTaskId: string | null;
  feedback: string[];
  planRevision: number;
  backendRequired: boolean;
};
export type ProjectDoc = { path: string; title: string; content: string };
export type FrontendWorkflowStage =
  | "planning"
  | "plan_approved"
  | "slice_planning"
  | "slice_implementing"
  | "slice_verifying"
  | "slice_reviewing"
  | "awaiting_feedback"
  | "frontend_complete"
  | "blocked";
export type FrontendWorkflowState = {
  version: 1;
  stage: FrontendWorkflowStage;
  currentSlice: number;
  totalSlices: number;
  taskId: string | null;
  updatedAt: string;
  detail: string;
};

const folder = ".localcode/build";
const stateFile = "state.md";
const workflowFile = "workflow.md";
const designBriefFile = "design-brief.md";
const legacyStateFile = "state.json";
const planMarker = /<borg-project-plan>([\s\S]*?)<\/borg-project-plan>/i;

function docsDirectory(root: string) {
  const parent = join(resolve(root), ".localcode");
  const dir = join(parent, "build");
  if ([parent, dir].some((path) => existsSync(path) && !lstatSync(path).isDirectory())) throw new Error("Build docs path is not a normal directory.");
  return dir;
}
function statePath(root: string) { return join(docsDirectory(root), stateFile); }
function workflowPath(root: string) { return join(docsDirectory(root), workflowFile); }
function safeRead(path: string) { return existsSync(path) && lstatSync(path).isFile() ? readFileSync(path, "utf8") : ""; }
function writeFileSync(path: string, content: string) {
  if (existsSync(path) && !lstatSync(path).isFile()) throw new Error("Build doc path is not a normal file.");
  writeRawFileSync(path, content, "utf8");
}
function clean(value: unknown, fallback = "") { return String(value ?? fallback).trim(); }
function list(value: unknown, fallback: string[] = []) {
  return Array.isArray(value) ? value.map((item) => clean(item)).filter(Boolean).slice(0, 40) : fallback;
}
function slug(value: string, index: number) {
  const next = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return next || `item-${index + 1}`;
}
function route(value: unknown, fallback: string) {
  const next = clean(value, fallback).replace(/\s+/g, "-").toLowerCase();
  return next.startsWith("/") ? next : `/${next.replace(/^\/+/, "")}`;
}

function normalizedRequirement(value: string) {
  return value.toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(?:page|screen|view|route)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function requestedByBrief(brief: string, pattern: RegExp) {
  const matcher = new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`);
  for (const match of brief.matchAll(matcher)) {
    const start = match.index ?? 0;
    const clauseStart = Math.max(0, Math.max(
      brief.lastIndexOf(".", start),
      brief.lastIndexOf("!", start),
      brief.lastIndexOf("?", start),
      brief.lastIndexOf("\n", start),
    ) + 1);
    const clause = brief.slice(clauseStart, start).toLowerCase();
    if (!/(?:\bdo\s+not\b|\bdon't\b|\bwithout\b|\bnever\b|\bavoid\b|\bno\b)/i.test(clause)) return true;
  }
  return false;
}

const commonApplicationPages = [
  "Overview", "Schedule", "Jobs", "Job Detail", "Customers", "Customer Detail",
  "Technicians", "Technician Detail", "Vehicles", "Inventory", "Reports", "Settings",
  "Dashboard", "Activity", "Users", "User Detail", "Teams", "Team Detail",
  "Projects", "Project Detail", "Tasks", "Task Detail", "Orders", "Order Detail",
  "Analytics", "Billing", "Notifications", "Profile",
];

export function extractExplicitPageRequirements(brief: string): string[] {
  const found: string[] = [];
  const add = (value: string) => {
    const cleaned = value
      .replace(/^[\s\-*\d.)]+/, "")
      .replace(/^(?:and|or)\s+/i, "")
      .replace(/\b(?:pages?|screens?|routes?|views?)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[,:;]+$/, "");
    if (
      !cleaned
      || cleaned.length > 80
      || /^(?:in this order|in build order|beginning with|in order)\b/i.test(cleaned)
      || /^(?:names?|purposes?|routes?|sections?|components?|features?|a few lightweight section hints?)$/i.test(cleaned)
    ) return;
    const key = normalizedRequirement(cleaned);
    if (!key || found.some((item) => normalizedRequirement(item) === key)) return;
    found.push(cleaned);
  };

  const cues = /(?:at\s+minimum|required\s+(?:pages?|screens?|routes?)|must\s+(?:include|contain|provide)|(?:pages?|screens?|routes?)\s*(?:include|are|:))\s*:?[ \t]*([^\n.]+)/gi;
  for (const match of brief.matchAll(/^\s*\d+[.)]\s*([^:\n]+?)(?:\s*:\s*\/[^\s]*)?\s*$/gm)) add(match[1]);
  for (const match of brief.matchAll(cues)) {
    for (const item of String(match[1] ?? "").split(/\s*,\s*|\s*;\s*|\s+and\s+/i)) add(item);
  }

  const orderedList = brief.match(/(?:required pages?|pages?)(?:\s*,?\s*in this order)?\s*:\s*([\s\S]*?)(?=\n\s*\n|\n\s*(?:This is|Use progressive|Do not|After)\b|$)/i)?.[1] ?? "";
  for (const match of orderedList.matchAll(/^\s*(?:\d+[.)]|[-*•])\s*([^:\n]+?)(?:\s*:\s*\/[^\s]*)?\s*$/gm)) add(match[1]);

  if (found.length < 3) {
    const lower = brief.toLowerCase();
    const lexicalMatches = commonApplicationPages.filter((name) => {
      const phrase = normalizedRequirement(name).replace(/\s+/g, "\\s+");
      return new RegExp(`\\b${phrase}\\b`, "i").test(lower);
    });
    if (lexicalMatches.length >= 4) for (const item of lexicalMatches) add(item);
  }

  return found.slice(0, 30);
}

function applicationRoute(name: string, index: number) {
  const normalized = normalizedRequirement(name);
  if (normalized === "overview" || normalized === "dashboard") return "/";
  const detail = normalized.match(/^(.+?) detail$/);
  if (detail) {
    const base = detail[1].replace(/\s+/g, "-");
    const plural = base.endsWith("s") ? base : base.endsWith("y") ? `${base.slice(0, -1)}ies` : `${base}s`;
    return `/${plural}/:id`;
  }
  return index === 0 ? "/" : `/${slug(name, index)}`;
}

function applicationSections(name: string): string[] {
  const value = normalizedRequirement(name);
  if (/overview|dashboard/.test(value)) return ["Application navigation", "Operational KPIs", "Alerts and exceptions", "Active work queue", "Team availability", "Upcoming schedule"];
  if (/schedule/.test(value)) return ["Schedule controls", "Calendar / timeline", "Assignment state", "Conflicts and exceptions", "Loading / empty states"];
  if (/job detail/.test(value)) return ["Job summary", "Status and timeline", "Assignment", "Customer / site", "Materials and notes", "Activity and actions"];
  if (/jobs?/.test(value)) return ["Search / filters", "Jobs table / board", "Status and priority", "Assignment controls", "Bulk / row actions", "Loading / empty states"];
  if (/customer detail/.test(value)) return ["Customer summary", "Contacts and locations", "Jobs / history", "Notes", "Actions"];
  if (/customers?/.test(value)) return ["Search / filters", "Customer list / table", "Status / value summary", "Primary actions", "Loading / empty states"];
  if (/technician detail/.test(value)) return ["Technician summary", "Availability", "Assigned work", "Skills / coverage", "Performance context", "Actions"];
  if (/technicians?/.test(value)) return ["Availability summary", "Technician roster", "Skills / territory filters", "Assignment state", "Loading / empty states"];
  if (/vehicles?/.test(value)) return ["Fleet summary", "Vehicle list / table", "Status / maintenance", "Assignments", "Exceptions"];
  if (/inventory/.test(value)) return ["Inventory summary", "Search / filters", "Stock table", "Low-stock / exception states", "Adjust / transfer actions"];
  if (/reports?|analytics/.test(value)) return ["Report navigation", "Date / segment controls", "Operational metrics", "Charts / tables", "Export / drill-down actions"];
  if (/settings|billing|profile/.test(value)) return ["Settings navigation", "Configuration form", "Validation / save states", "Permission / error states"];
  return ["Search / filters", "Primary workspace", "Detail / inspection state", "Primary actions", "Loading / empty / error states"];
}

function simplePageSections(name: string): string[] {
  const normalized = normalizedRequirement(name);
  if (/home|overview|landing/.test(normalized)) return ["Navigation", "Hero", "Primary content", "Primary CTA", "Footer"];
  if (/work|project|portfolio|case study/.test(normalized)) return ["Selected work", "Project details", "Project navigation"];
  if (/service|offering/.test(normalized)) return ["Services overview", "Service details", "Contact CTA"];
  if (/about|studio|team|company/.test(normalized)) return ["Story", "Approach", "Contact CTA"];
  if (/contact|inquiry|quote/.test(normalized)) return ["Contact details", "Inquiry form", "Success and error states"];
  return ["Primary content", "Supporting details", "Primary CTA"];
}

function applicationSlices(sitemap: ProjectSitemapPage[]): ProjectSlice[] {
  if (!sitemap.length) return [];
  const slices: ProjectSlice[] = [{
    id: "application-foundation",
    title: "Application shell and operational overview",
    outcome: `The shared application shell and ${sitemap[0].name} screen work as a dense, credible operational workspace on desktop and mobile.`,
    scope: ["application navigation", "shared layout and design tokens", sitemap[0].name, ...sitemap[0].sections],
    acceptanceCriteria: ["application navigation is functional", `${sitemap[0].name} contains representative operational data and meaningful states`, "desktop and mobile compositions are intentional", "no placeholder or dead visible controls remain"],
  }];

  const remaining = sitemap.slice(1);
  for (let index = 0; index < remaining.length; index += 3) {
    const pages = remaining.slice(index, index + 3);
    const names = pages.map((page) => page.name);
    slices.push({
      id: `application-${index / 3 + 1}-${slug(names.join("-"), index)}`,
      title: names.join(", "),
      outcome: `${names.join(", ")} are implemented as complete, navigable application screens with realistic data, interactions, and edge states.`,
      scope: pages.flatMap((page) => [page.name, ...page.sections]).slice(0, 30),
      acceptanceCriteria: [
        ...names.map((name) => `${name} is reachable and materially implemented`),
        "visible controls have real local behavior or explicit disabled states",
        "loading, empty, and error states are represented where relevant",
      ],
    });
  }
  return slices;
}

export type PlanCapability =
  | "authentication"
  | "record_mutation"
  | "search_filtering"
  | "reporting"
  | "realtime_updates";

export type PlanCoverageReport = {
  valid: boolean;
  explicitRequiredPages: string[];
  missingPages: string[];
  missingSliceCoverage: string[];
  requiredCapabilities: PlanCapability[];
  missingCapabilities: PlanCapability[];
  contradictions: string[];
  issues: string[];
};

export type ProjectPlanValidation = PlanCoverageReport;

export function extractRequiredCapabilities(brief: string): PlanCapability[] {
  const required = new Set<PlanCapability>();
  if (requestedByBrief(brief, /\b(?:auth(?:entication)?|authenticated|unauthenticated|log\s?in|login|sign\s?in|signin|roles?|permissions?|protected\s+(?:routes?|pages?|areas?))\b/i)) required.add("authentication");
  if (requestedByBrief(brief, /\b(?:crud|(?:create|add)\s*(?:\/|,|and)?\s*(?:edit|update)(?:\s*(?:\/|,|and)?\s*(?:delete|remove))?|edit\s*(?:\/|,|and)?\s*(?:delete|remove)|manage\s+(?:jobs?|customers?|users?|records?|inventory|orders?))\b/i)) required.add("record_mutation");
  if (requestedByBrief(brief, /\b(?:search|filter(?:ing)?|sort(?:ing)?)\b/i)) required.add("search_filtering");
  if (requestedByBrief(brief, /\b(?:reports?|reporting|analytics|insights|metrics dashboard)\b/i)) required.add("reporting");
  if (requestedByBrief(brief, /\b(?:real[- ]?time|live\s+updates?|websocket|streaming updates?)\b/i)) required.add("realtime_updates");
  return [...required];
}

export function validateProjectPlanCoverage(plan: ProjectPlan, brief: string): PlanCoverageReport {
  const explicitRequiredPages = extractExplicitPageRequirements(brief);
  const pageCorpus = plan.sitemap.map((page) => [page.name, page.route, page.purpose].join(" ")).map(normalizedRequirement);
  const sliceCorpus = plan.slices.map((slice) => [slice.title, slice.outcome, ...slice.scope, ...slice.acceptanceCriteria].join(" ")).map(normalizedRequirement);
  const fullCorpus = normalizedRequirement([
    ...plan.pages,
    ...plan.features,
    ...plan.sitemap.flatMap((page) => [page.name, page.route, page.purpose, ...page.sections, ...page.acceptanceCriteria]),
    ...plan.components.flatMap((component) => [component.name, component.purpose, ...component.variants, ...component.acceptanceCriteria]),
    ...plan.slices.flatMap((slice) => [slice.title, slice.outcome, ...slice.scope, ...slice.acceptanceCriteria]),
    ...plan.acceptanceCriteria,
  ].join(" "));
  const covered = (corpus: string[], requirement: string) => {
    const required = normalizedRequirement(requirement);
    const tokens = required.split(" ").filter((token) => token.length > 1);
    return corpus.some((value) => value.includes(required) || tokens.every((token) => value.split(" ").includes(token)));
  };
  const missingPages = explicitRequiredPages.filter((item) => !covered(pageCorpus, item));
  const missingSliceCoverage = explicitRequiredPages.filter((item) => !covered(sliceCorpus, item));
  const requiredCapabilities = extractRequiredCapabilities(brief);
  const capabilityPatterns: Record<PlanCapability, RegExp> = {
    authentication: /\b(?:auth|authentication|login|log in|sign in|signin|session|identity|credentials?|authenticated|unauthenticated|access control|role-based access|rbac|protected (?:route|routes|page|pages|area|areas))\b/i,
    record_mutation: /\b(?:create|add|edit|update|delete|remove|manage|management|adjust|transfer|archive|publish|save changes)\b/i,
    search_filtering: /\b(?:search|filter|filtering|sort|sorting)\b/i,
    reporting: /\b(?:report|reports|reporting|analytics|insights|metrics|export|charts?)\b/i,
    realtime_updates: /\b(?:real time|realtime|live updates|websocket|stream|streaming)\b/i,
  };
  const missingCapabilities = requiredCapabilities.filter((capability) => !capabilityPatterns[capability].test(fullCorpus));

  const dashboard = requestedByBrief(brief, /\b(?:dashboard|portal|admin|operations|internal\s+(?:app|tool)|control\s+center|dispatcher)\b/i);
  const explicitlyNotMarketing = /do\s+not\s+(?:build|make|create).{0,30}(?:marketing|landing)|not\s+a\s+(?:marketing|landing)\s+(?:site|page)|do\s+not\s+create\s+a\s+landing[- ]page/i.test(brief);
  const marketingSlices = dashboard
    ? plan.slices.filter((slice) => /homepage|hero|marketing|calls? to action|testimonials?|pricing section/i.test([slice.title, slice.outcome, ...slice.scope].join(" "))).map((slice) => slice.title)
    : [];
  const marketingPlanText = [
    ...plan.sitemap.flatMap((page) => [page.name, ...page.sections]),
    ...plan.slices.flatMap((slice) => [slice.title, slice.outcome, ...slice.scope]),
  ].join(" ");
  const contradictions = [
    ...(marketingSlices.length ? [`Internal application brief received marketing-site slices: ${marketingSlices.join(", ")}.`] : []),
    ...(explicitlyNotMarketing && /\b(?:hero|testimonial|marketing|landing page|call to action|cta)\b/i.test(marketingPlanText)
      ? ["The brief explicitly rejects a marketing/landing-site composition, but the plan still contains marketing-site structure."]
      : []),
  ];
  const issues = [
    ...(missingPages.length ? [`Missing required sitemap pages: ${missingPages.join(", ")}.`] : []),
    ...(missingSliceCoverage.length ? [`Required pages are not explicitly assigned to an implementation slice: ${missingSliceCoverage.join(", ")}.`] : []),
    ...(missingCapabilities.length ? [`Missing required product capabilities: ${missingCapabilities.join(", ")}.`] : []),
    ...contradictions,
  ];
  return {
    valid: issues.length === 0,
    explicitRequiredPages,
    missingPages,
    missingSliceCoverage,
    requiredCapabilities,
    missingCapabilities,
    contradictions,
    issues,
  };
}

export type ProjectPlanParseResult = {
  plan: ProjectPlan;
  source: "model" | "repaired" | "fallback";
  fallbackReason: string | null;
  repairReason?: string | null;
  validation: ProjectPlanValidation;
  retryRecommended: boolean;
};

function complexApplicationBrief(brief: string) {
  const required = extractExplicitPageRequirements(brief);
  return required.length >= 4 || (requestedByBrief(brief, /\b(?:full[- ]stack|dashboard|portal|operations|internal app|admin)\b/i) && brief.length >= 500);
}
function fallbackStyles(commerce: boolean): ProjectStyleSystem {
  return {
    direction: commerce
      ? "Premium mobile-first commerce with strong product imagery, disciplined editorial hierarchy, dense discovery where useful, and calm trustworthy transaction surfaces."
      : "A premium, restrained product interface with editorial hierarchy, deliberate whitespace, strong type contrast, and reusable visual primitives that create coherence before feature components are introduced.",
    colors: commerce
      ? ["canvas: #0B0D10", "surface: #12161C", "surface-raised: #181E27", "text-primary: #F5F7FA", "text-secondary: #98A2B3", "border-subtle: #2A313C", "accent: #B7FF5A", "danger: #FF6B6B", "success: #66D9A3"]
      : ["canvas: #0D1015", "surface: #141922", "surface-raised: #1B2230", "text-primary: #F4F7FB", "text-secondary: #9AA6B6", "border-subtle: #2B3442", "accent: #A7FF4F", "danger: #FF6B72", "success: #64D8A3"],
    typography: [
      "display-xl: 48px/52px, weight 650, tracking -0.035em",
      "heading-lg: 32px/38px, weight 620, tracking -0.025em",
      "heading-md: 24px/30px, weight 600, tracking -0.018em",
      "body-lg: 17px/28px, weight 400",
      "body: 15px/24px, weight 400",
      "label: 12px/16px, weight 600, tracking 0.02em",
    ],
    spacing: ["space-1: 4px", "space-2: 8px", "space-3: 12px", "space-4: 16px", "space-6: 24px", "space-8: 32px", "space-12: 48px", "space-16: 64px", "section-rhythm: 72-112px desktop / 48-72px mobile"],
    radii: ["radius-sm: 6px", "radius-md: 10px", "radius-lg: 16px"],
    shadows: ["elevation-1: 0 1px 2px rgba(0,0,0,.18)", "elevation-2: 0 12px 32px rgba(0,0,0,.22)"],
    layoutPrinciples: ["content-max: 1440px with 40px desktop gutters", "reading-max: 720px for long-form copy", "Use a 12-column desktop grid and composition-specific spans rather than repeated equal cards.", "Preserve strong alignment anchors while varying section density and visual weight."],
    motion: ["interactive: 160ms cubic-bezier(.2,.8,.2,1)", "enter: 240ms cubic-bezier(.16,1,.3,1)", "Reduced motion removes transforms and nonessential entrance animation while preserving state feedback."],
    responsive: ["desktop >= 1200px: full navigation and multi-column compositions", "tablet 768-1199px: reduce grid spans and gutters to 24px", "mobile < 768px: 16px gutters and intentional recomposition rather than mechanical stacking", "Touch targets remain at least 44px and primary actions stay reachable without horizontal overflow."],
    accessibility: ["Maintain visible keyboard focus with a dedicated accent focus ring.", "Target WCAG AA contrast for body text and interactive controls.", "Do not rely on color alone for status or validation meaning.", "Preserve semantic heading order and reduced-motion preference."],
    avoid: ["Centered-everything layouts", "Repetitive generic card grids", "Arbitrary gradients", "Excessive pill styling", "One-off color/spacing/radius values that bypass shared tokens", "Mobile layouts that merely stack desktop without reprioritizing content"],
  };
}
function fallbackSitemap(brief: string, commerce: boolean, dashboard: boolean, contentHeavy: boolean, seller: boolean, admin: boolean, accounts: boolean): ProjectSitemapPage[] {
  const text = brief.toLowerCase();
  const pages: Array<{ name: string; route: string; purpose: string; sections: string[] }> = [];
  const add = (name: string, pageRoute: string, purpose: string, sections: string[]) => {
    if (!pages.some((page) => page.route === pageRoute)) pages.push({ name, route: pageRoute, purpose, sections });
  };
  const explicitPages = extractExplicitPageRequirements(brief);
  if (commerce) {
    add("Home", "/", "Introduce the marketplace and drive product discovery.", ["Navigation", "Hero / discovery entry", "Featured products", "Categories", "Trust / social proof", "Primary CTA", "Footer"]);
    add("Discovery", "/discover", "Browse personalized and editorial discovery feeds.", ["Discovery controls", "Feed", "Creator / seller recommendations", "Loading and empty states"]);
    add("Search", "/search", "Search, filter, sort, and compare products.", ["Search input", "Filter / sort controls", "Results", "No-results state"]);
    add("Product", "/products/:id", "Evaluate a product and choose a purchasable variant.", ["Media gallery", "Product summary", "Variant selection", "Seller summary", "Reviews", "Related products"]);
    add("Cart", "/cart", "Review and edit intended purchases.", ["Cart groups", "Line items", "Totals", "Saved items", "Checkout CTA"]);
    add("Checkout", "/checkout", "Complete the purchase flow with clear validation.", ["Contact / address", "Delivery", "Payment", "Order review", "Validation states"]);
    add("Order confirmation", "/orders/:id/confirmation", "Confirm purchase and explain next steps.", ["Confirmation", "Order summary", "Next actions"]);
    if (accounts) add("Account", "/account", "Manage identity, saved data, and order history.", ["Profile", "Addresses", "Wishlist", "Recently viewed", "Orders"]);
    if (seller) {
      add("Seller storefront", "/sellers/:id", "Present a seller's brand and catalog.", ["Seller identity", "Catalog", "Policies / trust", "Reviews"]);
      add("Seller dashboard", "/seller", "Manage products, inventory, orders, and store performance.", ["Seller navigation", "Overview", "Products", "Inventory", "Orders", "Promotions", "Analytics"]);
    }
    if (admin) add("Admin", "/admin", "Operate marketplace-wide administration.", ["Admin navigation", "Overview", "Users", "Sellers", "Products", "Orders", "Reviews", "Categories", "Promotions"]);
  } else if (dashboard) {
    const requiredPages = extractExplicitPageRequirements(brief);
    const applicationPages = requiredPages.length >= 3 ? requiredPages : ["Overview", "Activity", "Settings"];
    for (const [index, name] of applicationPages.entries()) {
      add(name, applicationRoute(name, index), `${name} operational workspace required by the product brief.`, applicationSections(name));
    }
  } else if (!dashboard && explicitPages.length >= 2) {
    for (const [index, name] of explicitPages.entries()) {
      add(
        name,
        index === 0 ? "/" : `/${slug(name, index)}`,
        `${name} page required by the approved brief.`,
        simplePageSections(name),
      );
    }
  } else {
    add("Home", "/", "Communicate the primary value proposition and direct users into the site's core journey.", ["Navigation", "Hero", "Primary proof / value sections", "Primary CTA", "Footer"]);
    if (/service|offering|solution/.test(text)) add("Services", "/services", "Explain services or solutions in enough detail to support a decision.", ["Services overview", "Service details", "Proof / process", "CTA"]);
    if (/portfolio|project|work|case study/.test(text)) add("Work", "/work", "Show representative work and outcomes.", ["Work index", "Featured case studies", "Project cards", "CTA"]);
    if (/about|team|company|story/.test(text)) add("About", "/about", "Explain the people, story, and credibility behind the site.", ["Story", "Team / credibility", "Values / approach", "CTA"]);
    if (/pricing|plan|subscription/.test(text)) add("Pricing", "/pricing", "Explain plans, value, and purchasing choices.", ["Plan comparison", "Feature comparison", "FAQ", "CTA"]);
    if (contentHeavy) add("Articles", "/articles", "Support content discovery and reading.", ["Featured content", "Categories / filters", "Article list", "Search"]);
    if (/contact|lead|book|appointment|quote|waitlist|signup|sign up/.test(text)) add("Contact", "/contact", "Provide the primary conversion or contact path.", ["Contact / conversion form", "Trust details", "Alternative contact", "Success / error states"]);
  }
  return pages.map((page, index) => ({
    id: slug(page.name, index),
    ...page,
    componentIds: [],
    acceptanceCriteria: ["Route is reachable and intentional.", "All listed sections are represented.", "Responsive and accessible behavior is defined."],
  }));
}
function fallbackComponents(sitemap: ProjectSitemapPage[]): PlannedComponent[] {
  const components = new Map<string, PlannedComponent>();
  const add = (name: string, kind: PlannedComponent["kind"], purpose: string, pageId: string, index: number) => {
    const id = slug(name, index);
    const existing = components.get(id);
    if (existing) {
      if (!existing.usedBy.includes(pageId)) existing.usedBy.push(pageId);
      return id;
    }
    components.set(id, { id, name, kind, purpose, usedBy: [pageId], variants: [], acceptanceCriteria: ["Reusable where its role repeats.", "Responsive and accessible states are defined."] });
    return id;
  };
  for (const page of sitemap) {
    page.componentIds = page.sections.map((section, index) => add(
      section,
      /navigation|footer/i.test(section) ? "layout" : /form|search|filter|control|gallery|table|list|card/i.test(section) ? "feature" : "section",
      `${section} for ${page.name}.`,
      page.id,
      index,
    ));
  }
  return [...components.values()];
}
function writeState(root: string, state: SliceState) {
  const dir = docsDirectory(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(statePath(root), `# BORG build state\n\n> Generated projection only. SQLite WorkflowEngine state owns progression.\n\n\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\`\n`);
}

export function setFrontendWorkflowStage(root: string, stage: FrontendWorkflowStage, input: { currentSlice?: number; totalSlices?: number; taskId?: string | null; detail?: string } = {}): FrontendWorkflowState {
  const previous = readFrontendWorkflowState(root);
  const state: FrontendWorkflowState = {
    version: 1,
    stage,
    currentSlice: Math.max(0, input.currentSlice ?? previous?.currentSlice ?? 0),
    totalSlices: Math.max(0, input.totalSlices ?? previous?.totalSlices ?? 0),
    taskId: input.taskId === undefined ? previous?.taskId ?? null : input.taskId,
    updatedAt: new Date().toISOString(),
    detail: input.detail?.trim().slice(0, 2000) ?? previous?.detail ?? "",
  };
  const dir = docsDirectory(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(workflowPath(root), `# Frontend workflow\n\n> Generated projection only. SQLite WorkflowEngine state owns progression.\n\nStage: **${state.stage.replaceAll("_", " ")}**\n\n\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\`\n`);
  return state;
}

export function readFrontendWorkflowState(root: string): FrontendWorkflowState | null {
  try {
    const match = safeRead(workflowPath(root)).match(/\`\`\`json\s*([\s\S]*?)\s*\`\`\`/i);
    if (!match) return null;
    const value = JSON.parse(match[1]) as FrontendWorkflowState;
    return value.version === 1 && typeof value.stage === "string" ? value : null;
  } catch { return null; }
}

export function persistDesignBrief(root: string, brief: Record<string, unknown>) {
  const dir = docsDirectory(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, designBriefFile), `# Approved design brief\n\nThis brief is durable project-level frontend context and must be inherited by every frontend slice.\n\n\`\`\`json\n${JSON.stringify(brief, null, 2)}\n\`\`\`\n`);
}

export function readPersistedDesignBrief(root: string): Record<string, unknown> | null {
  try {
    const match = safeRead(join(docsDirectory(root), designBriefFile)).match(/\`\`\`json\s*([\s\S]*?)\s*\`\`\`/i);
    if (!match) return null;
    const value = JSON.parse(match[1]) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}
function planMarkdown(plan: ProjectPlan) {
  const flows = plan.flows ?? [];
  return `# Approved frontend phase plan\n\nStatus: **${plan.status.replaceAll("_", " ")}** · Revision ${plan.revision}\n\n## Site goal\n\n${plan.siteGoal}\n\n## Audience\n\n${plan.audience}\n\n## Visual direction\n\n${plan.visualDirection}\n\n## Sitemap\n\n${plan.sitemap.map((page) => `- **${page.name}** \`${page.route}\` — ${page.purpose}\n  - Sections: ${page.sections.join("; ")}`).join("\n")}\n\n## User journeys\n\n${flows.length ? flows.map((flow) => `- **${flow.name}** — ${flow.purpose}\n  - Path: ${flow.steps.join(" → ")}`).join("\n") : "- No multi-page journey required."}\n\n## Planned components\n\n${plan.components.map((component) => `- **${component.name}** [${component.kind}] — ${component.purpose}\n  - Used by: ${component.usedBy.join(", ") || "shared/global"}`).join("\n")}\n\n## Global style system\n\n${plan.styles.direction}\n\n- Colors: ${plan.styles.colors.join("; ")}\n- Typography: ${plan.styles.typography.join("; ")}\n- Spacing: ${plan.styles.spacing.join("; ")}\n- Radii: ${plan.styles.radii.join("; ")}\n- Shadows: ${plan.styles.shadows.join("; ")}\n- Layout: ${plan.styles.layoutPrinciples.join("; ")}\n- Motion: ${plan.styles.motion.join("; ")}\n- Responsive: ${plan.styles.responsive.join("; ")}\n- Accessibility: ${plan.styles.accessibility.join("; ")}\n- Avoid: ${plan.styles.avoid.join("; ")}\n\n## Features\n\n${plan.features.map((item) => `- ${item}`).join("\n") || "- Content and navigation"}\n\n## Frontend slices\n\n${plan.slices.map((slice, index) => `${index + 1}. **${slice.title}** — ${slice.outcome}\n   - Scope: ${slice.scope.join("; ") || "As defined by the approved brief"}\n   - Acceptance: ${slice.acceptanceCriteria.join("; ") || "Working preview and relevant verification"}`).join("\n")}\n\n## Frontend completion gate\n\n${plan.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}\n\n## Backend phase\n\n${plan.backendRequired ? "Required after frontend approval because the brief needs server features, stored data, accounts, or integrations." : "Not required by the approved brief. The site may be marked complete after the frontend completion gate passes."}\n\n<borg-project-plan>${JSON.stringify(plan)}</borg-project-plan>\n`;
}
function stateFromPlan(plan: ProjectPlan, brief: string, status: SliceState["status"], taskId: string | null, previous?: SliceState | null): SliceState {
  const current = Math.max(0, Math.min(previous?.current ?? 0, Math.max(0, plan.slices.length - 1)));
  return {
    version: 2,
    current,
    total: plan.slices.length,
    currentTitle: plan.slices[current]?.title ?? "Frontend",
    status,
    brief: brief.trim() || previous?.brief || plan.siteGoal,
    lastTaskId: taskId,
    feedback: previous?.feedback ?? [],
    planRevision: plan.revision,
    backendRequired: plan.backendRequired,
  };
}

export function readSliceState(root: string): SliceState | null {
  try {
    const markdown = safeRead(statePath(root));
    const match = markdown.match(/\`\`\`json\s*([\s\S]*?)\s*\`\`\`/i);
    if (match) {
      const value = JSON.parse(match[1]) as SliceState;
      if (value.version === 2 && Number.isInteger(value.current) && Array.isArray(value.feedback)) return value;
    }
    const legacy = safeRead(join(docsDirectory(root), legacyStateFile));
    if (!legacy) return null;
    const old = JSON.parse(legacy) as { current?: number; status?: string; brief?: string; lastTaskId?: string | null; feedback?: string[] };
    if (!Number.isInteger(old.current) || !Array.isArray(old.feedback)) return null;
    return { version: 2, current: old.current!, total: 0, currentTitle: "Legacy frontend slice", status: old.status === "frontend_complete" ? "frontend_complete" : old.status === "awaiting_feedback" ? "awaiting_feedback" : "working", brief: old.brief ?? "", lastTaskId: old.lastTaskId ?? null, feedback: old.feedback, planRevision: 1, backendRequired: true };
  } catch { return null; }
}

export function readProjectPlan(root: string): ProjectPlan | null {
  try {
    const match = safeRead(join(docsDirectory(root), "plan.md")).match(planMarker);
    if (!match) return null;
    const value = JSON.parse(match[1]) as Partial<ProjectPlan>;
    if (value.version !== 2 || !Array.isArray(value.slices) || !value.slices.length) return null;
    const pages = Array.isArray(value.pages) ? value.pages : [];
    const sitemap = Array.isArray(value.sitemap) && value.sitemap.length
      ? value.sitemap
      : pages.map((name, index) => ({ id: slug(name, index), name, route: index === 0 ? "/" : `/${slug(name, index)}`, purpose: `${name} page.`, sections: [], componentIds: [], acceptanceCriteria: [] }));
    const components = Array.isArray(value.components) ? value.components : fallbackComponents(sitemap);
    return {
      ...(value as ProjectPlan),
      pages: pages.length ? pages : sitemap.map((page) => page.name),
      sitemap,
      flows: Array.isArray(value.flows) ? value.flows : fallbackFlows(sitemap),
      components,
      styles: value.styles ?? fallbackStyles(false),
    };
  } catch { return null; }
}

export function fallbackProjectPlan(brief: string, template = ""): ProjectPlan {
  const text = brief.toLowerCase();
  const explicitPages = extractExplicitPageRequirements(brief);
  // "Product" is common in software and agency briefs and is not evidence of a store.
  // Require an explicit commerce concept before selecting the commerce fallback plan.
  const commerce = requestedByBrief(text, /e.?commerce|commerce|marketplace|\bshop(?:ping)?\b|\bstorefront\b|\bcatalog\b|\bcart\b|\bcheckout\b/i)
    || (template === "ecommerce" && !/\b(?:do\s+not|don't|without|avoid|no)\b[^.\n]{0,40}\b(?:e.?commerce|store|shop|cart|checkout)\b/i.test(text));
  const dashboard = requestedByBrief(text, /\b(?:dashboard|portal|admin|operations|analytics)\b/i)
    || (template === "dashboard" && !/\b(?:do\s+not|don't|without|avoid|no)\b[^.\n]{0,40}\b(?:dashboard|admin|operations|analytics)\b/i.test(text));
  const contentHeavy = requestedByBrief(`${template} ${text}`, /\b(?:blog|content|news|docs|documentation|magazine)\b/i);
  const social = requestedByBrief(text, /\b(?:social|creator|feed|follow|favorite|wishlist|review|trending|recommend)\b/i);
  const seller = requestedByBrief(text, /\b(?:seller|merchant|storefront|inventory|sku)\b/i);
  const admin = requestedByBrief(text, /\b(?:admin|moderation|role|permission)\b/i);
  const accounts = requestedByBrief(text, /\b(?:account|auth|login|sign.?up|profile|order|wishlist)\b/i);
  const backendRequired = briefForcesFrontendOnly(brief)
    ? false
    : requestedByBrief(text, /\b(?:account|auth|login|database|persist|checkout|payment|booking|order|cart|upload|message|api|integration|dashboard|seller|admin)\b/i);
  const slices: ProjectSlice[] = [];

  if (commerce) {
    slices.push(
      {
        id: "commerce-foundation",
        title: "Commerce foundation and discovery shell",
        outcome: "A polished responsive marketplace shell, mobile navigation, home/discovery entry points, and representative seeded content are usable in the preview.",
        scope: ["design tokens and application shell", "mobile and desktop navigation", "home composition", "discovery feed shell", "seeded product, seller, and category presentation"],
        acceptanceCriteria: ["home and discovery are navigable", "desktop and mobile layouts are intentional", "visible navigation and discovery controls work", "representative data makes the marketplace feel populated"],
      },
      {
        id: "catalog-product",
        title: "Catalog, search, and product purchase surface",
        outcome: "Users can discover products through search and filtering, open complete product details, select valid variants, and reach purchase actions.",
        scope: ["search and suggestions", "filters and sorting", "product detail", "media gallery", "variant and inventory states", "seller and review summaries", "related-product presentation"],
        acceptanceCriteria: ["search/filter/sort modify results", "variant selection changes the selected SKU", "out-of-stock states are enforced in the UI", "product pages work across target viewport sizes"],
      },
      {
        id: "cart-checkout",
        title: "Cart and checkout journey",
        outcome: "A user can add variant-specific items, edit a persistent cart, and complete a validated development checkout journey through confirmation.",
        scope: ["cart persistence and seller grouping", "quantity/remove/save-for-later interactions", "discount/shipping/tax presentation", "multi-step checkout", "validation and failure states", "order confirmation frontend contract"],
        acceptanceCriteria: ["cart survives refreshes", "totals derive from shared commerce logic rather than hard-coded UI values", "checkout validates required fields", "unavailable inventory cannot proceed", "development payment mode is clearly identified"],
      },
    );

    if (accounts) slices.push({
      id: "account-orders",
      title: "Authentication-facing account and order experiences",
      outcome: "Account, wishlist, recently viewed, addresses, and order-center experiences are complete and wired to explicit persistence/auth contracts for the backend phase.",
      scope: ["login/signup/reset surfaces", "protected-area states", "profile and addresses", "wishlist and recently viewed", "order center and order detail", "review-product entry points"],
      acceptanceCriteria: ["authenticated and unauthenticated states are explicit", "wishlist/cart handoffs work", "order states and timelines render coherently", "backend-required actions are documented in the data/action contract"],
    });

    if (social) slices.push({
      id: "social-commerce",
      title: "Social-commerce discovery and engagement",
      outcome: "Discovery feels creator-driven rather than like a conventional product grid, with working follows, favorites, shares, popularity signals, and deterministic recommendation behavior represented in the frontend contract.",
      scope: ["For You/Trending/New/Deals/Following modes", "creator recommendations", "multiple discovery presentation types", "favorites and share interactions", "seller follows", "recommendation explanation and ranking contract"],
      acceptanceCriteria: ["feed modes visibly change content", "engagement actions have clear state transitions", "desktop adapts the feed rather than stretching mobile UI", "ranking signals are documented and reproducible"],
    });

    if (seller) slices.push({
      id: "seller-experience",
      title: "Seller storefront and management workspace",
      outcome: "Seller storefronts feel distinct and seller-management flows cover products, variants, inventory, orders, promotions, analytics, and store customization.",
      scope: ["seller storefront", "seller dashboard", "product create/edit/archive", "variant/SKU/inventory management", "orders and customer views", "promotions and analytics", "store customization"],
      acceptanceCriteria: ["seller routes are navigable and role-aware", "product-management forms validate representative data", "analytics derive from seeded/shared data", "publish/unpublish states are represented end to end"],
    });

    if (admin) slices.push({
      id: "admin-experience",
      title: "Administrator marketplace controls",
      outcome: "The administrator area provides separate role-aware views over users, sellers, products, orders, reviews, categories, promotions, and marketplace statistics.",
      scope: ["admin shell and navigation", "marketplace overview", "users/sellers/products/orders/reviews", "categories and promotions", "at least one legitimate administrative action", "permission-denied states"],
      acceptanceCriteria: ["admin pages are distinct from seller tooling", "role boundaries are explicit in UI and backend contract", "the administrative action updates representative state", "unauthorized states are handled intentionally"],
    });
  } else if (dashboard) {
    const applicationSitemap = fallbackSitemap(brief, false, true, contentHeavy, seller, admin, accounts);
    slices.push(...applicationSlices(applicationSitemap));
  } else if (explicitPages.length >= 2) {
    for (const name of explicitPages) {
      slices.push({
        id: slug(name, slices.length),
        title: `${name} page`,
        outcome: `The ${name} page is implemented as a coherent, navigable experience using the approved global styles.`,
        scope: [name, ...simplePageSections(name)],
        acceptanceCriteria: [`${name} is reachable and materially represented`, "responsive and accessible behavior is intentional"],
      });
    }
  } else {
    slices.push(
      { id: "foundation", title: "Homepage shell and hero", outcome: "The homepage navigation, visual foundation, and hero are polished and usable in the preview.", scope: ["design tokens and layout shell", "header and navigation", "homepage hero", "basic responsive and accessible behavior"], acceptanceCriteria: ["hero communicates the primary offer", "desktop and mobile layouts are usable", "visible navigation controls work"] },
      { id: "homepage-sections", title: contentHeavy ? "Homepage content and discovery sections" : "Homepage sections and calls to action", outcome: "The homepage sections below the hero form a complete, coherent page with working calls to action.", scope: ["approved homepage content sections", "reusable section components", "section imagery and copy", "calls to action and interaction states"], acceptanceCriteria: ["all approved homepage sections are present", "section components work across target viewports", "calls to action have a meaningful destination or state"] },
      { id: "content-flows", title: contentHeavy ? "Content structure and discovery" : "Remaining pages and interactions", outcome: "The remaining core pages, content, and interactions required by the brief work coherently.", scope: ["remaining core screens", "interaction states", "loading, empty, and error states where relevant"], acceptanceCriteria: ["approved pages are reachable", "core interactions work", "relevant states are represented"] },
    );
  }

  slices.push({
    id: "frontend-review",
    title: "Frontend completion review",
    outcome: "The approved frontend passes responsive, accessibility, visual, build, browser, and interaction completion gates.",
    scope: ["responsive review", "accessibility review", "visual polish", "browser verification", "loading/empty/error states", "data/action contract", "cross-slice consistency"],
    acceptanceCriteria: ["typecheck and build pass", "key browser journeys pass", "mobile and desktop reviews pass", "accessibility and visual reviews are complete", "no obvious placeholder or dead-control quality remains"],
  });

  const sitemap = fallbackSitemap(brief, commerce, dashboard, contentHeavy, seller, admin, accounts);
  const components = fallbackComponents(sitemap);
  const pages = sitemap.map((page) => page.name);
  const features = commerce
    ? ["Product discovery", "Search and filtering", "Product variants", "Cart", "Checkout", "Orders", ...(social ? ["Social engagement", "Recommendations"] : []), ...(seller ? ["Seller management"] : []), ...(admin ? ["Administration"] : [])]
    : ["Content, navigation, and interactions required by the brief"];

  const now = new Date().toISOString();
  return {
    version: 2, revision: 1, status: "proposed", phase: "frontend",
    siteGoal: brief.trim() || "Build the requested website.",
    audience: commerce ? "Shoppers discovering and purchasing products, plus any seller/admin roles required by the brief." : "People described by the approved brief.",
    pages,
    features,
    sitemap,
    flows: fallbackFlows(sitemap),
    components,
    styles: fallbackStyles(commerce),
    visualDirection: commerce ? "Premium, mobile-first commercial product design with immersive discovery and trustworthy purchase flows." : "Follow the approved brief and Design Director direction; establish a coherent reusable visual system.",
    backendRequired, slices,
    acceptanceCriteria: [
      "Every approved page is navigable.",
      "Visible controls work with local data or are clearly identified as demonstrations.",
      "Loading, empty, and error states exist where relevant.",
      "Key journeys pass real browser review.",
      "Mobile, desktop, accessibility, and visual reviews are complete.",
    ],
    proposedAt: now, approvedAt: null,
  };
}

export type ProjectPlanParseOptions = {
  frozenProductMap?: ProductMap | null;
  frozenStyles?: ProjectStyleSystem | null;
};

export function parseProjectPlanResult(
  answer: string,
  brief: string,
  template = "",
  options: ProjectPlanParseOptions = {},
): ProjectPlanParseResult {
  const fallback = fallbackProjectPlan(brief, template);
  const frontendOnly = briefForcesFrontendOnly(brief);
  const resolvedBackendRequired = (value: unknown) =>
    frontendOnly ? false : typeof value === "boolean" ? value : fallback.backendRequired;
  const fallbackValidation = validateProjectPlanCoverage(fallback, brief);
  const applyFrozenAuthority = (plan: ProjectPlan) =>
    options.frozenProductMap && options.frozenStyles
      ? applyBlueprintFoundation(plan, options.frozenProductMap, options.frozenStyles)
      : plan;
  const selectFallback = (reason: string, candidateValidation: ProjectPlanValidation = fallbackValidation): ProjectPlanParseResult => ({
    plan: fallback,
    source: "fallback",
    fallbackReason: reason,
    validation: candidateValidation,
    retryRecommended: complexApplicationBrief(brief),
  });
  const artifact = structuredJsonArtifactBody(answer, "borg-project-plan");
  try {
    const parsedJson = parseStructuredJson<Record<string, unknown>>(artifact.body);
    const parsedRaw = parsedJson.value;
    if (!parsedRaw || typeof parsedRaw !== "object" || Array.isArray(parsedRaw)) throw new Error("Project Plan JSON root must be an object.");
    const nestedFrozen = parsedRaw.frozen as Record<string, unknown> | undefined;
    const nestedMap = nestedFrozen?.productMap as Record<string, unknown> | undefined;
    const nestedStyles = nestedFrozen?.styleSystem as Record<string, unknown> | undefined;
    const nestedQueue = Array.isArray(parsedRaw.pageQueue) ? parsedRaw.pageQueue : [];
    const raw = nestedMap || nestedStyles || nestedQueue.length
      ? {
          ...parsedRaw,
          siteGoal: clean(parsedRaw.siteGoal, clean(nestedMap?.siteGoal)),
          audience: clean(parsedRaw.audience, clean(nestedMap?.audience)),
          pages: list(parsedRaw.pages, list(nestedMap?.pages)),
          features: list(parsedRaw.features, list(nestedMap?.features)),
          sitemap: Array.isArray(parsedRaw.sitemap) && parsedRaw.sitemap.length ? parsedRaw.sitemap : nestedMap?.sitemap,
          flows: Array.isArray(parsedRaw.flows) && parsedRaw.flows.length ? parsedRaw.flows : nestedMap?.flows,
          backendRequired: resolvedBackendRequired(typeof parsedRaw.backendRequired === "boolean" ? parsedRaw.backendRequired : nestedMap?.backendRequired),
          styles: parsedRaw.styles ?? nestedStyles,
          slices: Array.isArray(parsedRaw.slices) && parsedRaw.slices.length
            ? parsedRaw.slices
            : nestedQueue.map((item, index) => {
                const value = item as Record<string, unknown>;
                return {
                  id: clean(value.id, clean(value.name, `slice-${index + 1}`)),
                  title: clean(value.name, `Page ${index + 1}`),
                  outcome: clean(value.purpose, "Deliver the current page boundary."),
                  scope: list(value.sections, [clean(value.name, "Current page")]),
                  acceptanceCriteria: list(value.acceptanceCriteria, []),
                };
              }),
          components: Array.isArray(parsedRaw.components) ? parsedRaw.components : [],
        }
      : parsedRaw;
    const rawSlices = Array.isArray(raw.slices) ? raw.slices.slice(0, 12) : [];
    const slices = rawSlices.map((item, index) => {
      const value = item as Record<string, unknown>;
      const title = clean(value.title, `Slice ${index + 1}`);
      return {
        id: slug(clean(value.id, title), index),
        title,
        outcome: clean(value.outcome, clean(value.goal, "Deliver a concrete user-visible outcome.")),
        scope: list(value.scope, ["Implement the approved outcome"]),
        acceptanceCriteria: list(value.acceptanceCriteria, ["Working preview", "Relevant verification passes"]),
      };
    }).filter((slice) => slice.title && slice.outcome);
    const repairSlices = (basis: ProjectSlice[]) => {
      const repaired = basis.map((slice, index) => ({
        ...slice,
        id: slug(clean(slice.id, slice.title), index),
      }));
      const seen = new Set(repaired.map((slice) => slice.id.toLowerCase()));
      for (const slice of slices) {
        if (!seen.has(slice.id.toLowerCase())) repaired.push(slice);
        seen.add(slice.id.toLowerCase());
      }
      return repaired;
    };
    if (slices.length < 2) {
      const generatedFallback = fallbackProjectPlan(brief, template).slices;
      const repairedSlices = repairSlices(generatedFallback);
      if (repairedSlices.length < 2) return selectFallback("Planner returned fewer than two usable implementation slices.");
      const framingRepair = artifact.framed ? null : artifact.framingRepair;
      const repairReason = [framingRepair, parsedJson.repairSummary, "expanded a single-slice blueprint into a bounded roadmap"].filter(Boolean).join("; ") || null;
      return {
        plan: {
          ...fallback,
          siteGoal: clean(raw.siteGoal, fallback.siteGoal),
          audience: clean(raw.audience, fallback.audience),
          pages: list(raw.pages, fallback.pages),
          features: list(raw.features, fallback.features),
          sitemap: Array.isArray(raw.sitemap) && raw.sitemap.length ? raw.sitemap.slice(0, 30).map((item, index) => {
            const value = item as Record<string, unknown>;
            const name = clean(value.name, clean(value.title, `Page ${index + 1}`));
            return {
              id: slug(clean(value.id, name), index),
              name,
              route: route(value.route, index === 0 ? "/" : `/${slug(name, index)}`),
              purpose: clean(value.purpose, `${name} page.`),
              sections: list(value.sections),
              componentIds: list(value.componentIds).map((componentId, componentIndex) => slug(componentId, componentIndex)),
              acceptanceCriteria: list(value.acceptanceCriteria, fallback.acceptanceCriteria),
            };
          }) : fallback.sitemap,
          flows: Array.isArray(raw.flows) && raw.flows.length ? (raw.flows as Record<string, unknown>[]).map((item, index) => {
            const value = item as Record<string, unknown>;
            const name = clean(value.name, `Journey ${index + 1}`);
            return {
              id: slug(clean(value.id, name), index),
              name,
              purpose: clean(value.purpose, `${name} user journey.`),
              steps: list(value.steps).map((pageId, pageIndex) => slug(pageId, pageIndex)),
            };
          }) : fallback.flows,
          components: Array.isArray(raw.components) && raw.components.length ? (raw.components as Record<string, unknown>[]).map((item, index) => {
            const value = item as Record<string, unknown>;
            const name = clean(value.name, `Component ${index + 1}`);
            const kind = ["layout", "section", "ui", "feature"].includes(String(value.kind)) ? String(value.kind) as PlannedComponent["kind"] : "section";
            return {
              id: slug(clean(value.id, name), index),
              name,
              kind,
              purpose: clean(value.purpose, `${name} reusable interface element.`),
              usedBy: list(value.usedBy).map((pageId, pageIndex) => slug(pageId, pageIndex)),
              variants: list(value.variants),
              acceptanceCriteria: list(value.acceptanceCriteria, ["Responsive and accessible states are defined."]),
            };
          }) : fallback.components,
          styles: {
            direction: normalizeStyleDirection((raw.styles as Record<string, unknown> | undefined)?.direction) || fallback.styles.direction,
            colors: list((raw.styles as Record<string, unknown> | undefined)?.colors, fallback.styles.colors),
            typography: list((raw.styles as Record<string, unknown> | undefined)?.typography, fallback.styles.typography),
            spacing: list((raw.styles as Record<string, unknown> | undefined)?.spacing, fallback.styles.spacing),
            radii: list((raw.styles as Record<string, unknown> | undefined)?.radii, fallback.styles.radii),
            shadows: list((raw.styles as Record<string, unknown> | undefined)?.shadows, fallback.styles.shadows),
            layoutPrinciples: list((raw.styles as Record<string, unknown> | undefined)?.layoutPrinciples, fallback.styles.layoutPrinciples),
            motion: list((raw.styles as Record<string, unknown> | undefined)?.motion, fallback.styles.motion),
            responsive: list((raw.styles as Record<string, unknown> | undefined)?.responsive, fallback.styles.responsive),
            accessibility: list((raw.styles as Record<string, unknown> | undefined)?.accessibility, fallback.styles.accessibility),
            avoid: list((raw.styles as Record<string, unknown> | undefined)?.avoid, fallback.styles.avoid),
          },
          visualDirection: normalizeStyleDirection(raw.visualDirection) || normalizeStyleDirection((raw.styles as Record<string, unknown> | undefined)?.direction) || fallback.visualDirection,
          backendRequired: resolvedBackendRequired(raw.backendRequired),
          slices: repairedSlices,
          acceptanceCriteria: list(raw.acceptanceCriteria, fallback.acceptanceCriteria),
        },
        source: "repaired",
        fallbackReason: null,
        repairReason,
        validation: validateProjectPlanCoverage({
          ...fallback,
          siteGoal: clean(raw.siteGoal, fallback.siteGoal),
          audience: clean(raw.audience, fallback.audience),
          pages: list(raw.pages, fallback.pages),
          features: list(raw.features, fallback.features),
          sitemap: Array.isArray(raw.sitemap) && raw.sitemap.length ? raw.sitemap.slice(0, 30).map((item, index) => {
            const value = item as Record<string, unknown>;
            const name = clean(value.name, clean(value.title, `Page ${index + 1}`));
            return {
              id: slug(clean(value.id, name), index),
              name,
              route: route(value.route, index === 0 ? "/" : `/${slug(name, index)}`),
              purpose: clean(value.purpose, `${name} page.`),
              sections: list(value.sections),
              componentIds: list(value.componentIds).map((componentId, componentIndex) => slug(componentId, componentIndex)),
              acceptanceCriteria: list(value.acceptanceCriteria, fallback.acceptanceCriteria),
            };
          }) : fallback.sitemap,
          flows: Array.isArray(raw.flows) && raw.flows.length ? (raw.flows as Record<string, unknown>[]).map((item, index) => {
            const value = item as Record<string, unknown>;
            const name = clean(value.name, `Journey ${index + 1}`);
            return {
              id: slug(clean(value.id, name), index),
              name,
              purpose: clean(value.purpose, `${name} user journey.`),
              steps: list(value.steps).map((pageId, pageIndex) => slug(pageId, pageIndex)),
            };
          }) : fallback.flows,
          components: Array.isArray(raw.components) && raw.components.length ? (raw.components as Record<string, unknown>[]).map((item, index) => {
            const value = item as Record<string, unknown>;
            const name = clean(value.name, `Component ${index + 1}`);
            const kind = ["layout", "section", "ui", "feature"].includes(String(value.kind)) ? String(value.kind) as PlannedComponent["kind"] : "section";
            return {
              id: slug(clean(value.id, name), index),
              name,
              kind,
              purpose: clean(value.purpose, `${name} reusable interface element.`),
              usedBy: list(value.usedBy).map((pageId, pageIndex) => slug(pageId, pageIndex)),
              variants: list(value.variants),
              acceptanceCriteria: list(value.acceptanceCriteria, ["Responsive and accessible states are defined."]),
            };
          }) : fallback.components,
          styles: {
            direction: normalizeStyleDirection((raw.styles as Record<string, unknown> | undefined)?.direction) || fallback.styles.direction,
            colors: list((raw.styles as Record<string, unknown> | undefined)?.colors, fallback.styles.colors),
            typography: list((raw.styles as Record<string, unknown> | undefined)?.typography, fallback.styles.typography),
            spacing: list((raw.styles as Record<string, unknown> | undefined)?.spacing, fallback.styles.spacing),
            radii: list((raw.styles as Record<string, unknown> | undefined)?.radii, fallback.styles.radii),
            shadows: list((raw.styles as Record<string, unknown> | undefined)?.shadows, fallback.styles.shadows),
            layoutPrinciples: list((raw.styles as Record<string, unknown> | undefined)?.layoutPrinciples, fallback.styles.layoutPrinciples),
            motion: list((raw.styles as Record<string, unknown> | undefined)?.motion, fallback.styles.motion),
            responsive: list((raw.styles as Record<string, unknown> | undefined)?.responsive, fallback.styles.responsive),
            accessibility: list((raw.styles as Record<string, unknown> | undefined)?.accessibility, fallback.styles.accessibility),
            avoid: list((raw.styles as Record<string, unknown> | undefined)?.avoid, fallback.styles.avoid),
          },
          visualDirection: normalizeStyleDirection(raw.visualDirection) || normalizeStyleDirection((raw.styles as Record<string, unknown> | undefined)?.direction) || fallback.visualDirection,
          backendRequired: resolvedBackendRequired(raw.backendRequired),
          slices: repairedSlices,
          acceptanceCriteria: list(raw.acceptanceCriteria, fallback.acceptanceCriteria),
        }, brief),
        retryRecommended: false,
      };
    }

    const rawSitemap = Array.isArray(raw.sitemap) ? raw.sitemap.slice(0, 30) : [];
    const sitemap = rawSitemap.length ? rawSitemap.map((item, index) => {
      const value = item as Record<string, unknown>;
      const name = clean(value.name, clean(value.title, `Page ${index + 1}`));
      const id = slug(clean(value.id, name), index);
      return {
        id,
        name,
        route: route(value.route, index === 0 ? "/" : `/${id}`),
        purpose: clean(value.purpose, `${name} page.`),
        sections: list(value.sections),
        componentIds: list(value.componentIds).map((componentId, componentIndex) => slug(componentId, componentIndex)),
        acceptanceCriteria: list(value.acceptanceCriteria, fallback.acceptanceCriteria),
      };
    }) : list(raw.pages, fallback.pages).map((name, index) => ({
      id: slug(name, index),
      name,
      route: index === 0 ? "/" : `/${slug(name, index)}`,
      purpose: `${name} page.`,
      sections: [],
      componentIds: [],
      acceptanceCriteria: fallback.acceptanceCriteria,
    }));

    const pageIds = new Set(sitemap.map((page) => page.id));
    const rawFlows = Array.isArray(raw.flows) ? raw.flows.slice(0, 20) : [];
    const flows = rawFlows.length ? rawFlows.map((item, index) => {
      const value = item as Record<string, unknown>;
      const name = clean(value.name, `Journey ${index + 1}`);
      return {
        id: slug(clean(value.id, name), index),
        name,
        purpose: clean(value.purpose, `${name} user journey.`),
        steps: list(value.steps).map((pageId, pageIndex) => slug(pageId, pageIndex)).filter((pageId) => pageIds.has(pageId)),
      };
    }).filter((flow) => flow.steps.length >= 2) : fallbackFlows(sitemap);
    const rawComponents = Array.isArray(raw.components) ? raw.components.slice(0, 80) : [];
    const components = rawComponents.length ? rawComponents.map((item, index) => {
      const value = item as Record<string, unknown>;
      const name = clean(value.name, `Component ${index + 1}`);
      const kind = ["layout", "section", "ui", "feature"].includes(String(value.kind)) ? String(value.kind) as PlannedComponent["kind"] : "section";
      return {
        id: slug(clean(value.id, name), index),
        name,
        kind,
        purpose: clean(value.purpose, `${name} reusable interface element.`),
        usedBy: list(value.usedBy).map((pageId, pageIndex) => slug(pageId, pageIndex)).filter((pageId) => pageIds.has(pageId)),
        variants: list(value.variants),
        acceptanceCriteria: list(value.acceptanceCriteria, ["Responsive and accessible states are defined."]),
      };
    }) : fallbackComponents(sitemap);

    const componentIds = new Set(components.map((component) => component.id));
    for (const page of sitemap) page.componentIds = page.componentIds.filter((id) => componentIds.has(id));
    for (const component of components) for (const pageId of component.usedBy) {
      const page = sitemap.find((candidate) => candidate.id === pageId);
      if (page && !page.componentIds.includes(component.id)) page.componentIds.push(component.id);
    }

    const rawStyles = raw.styles && typeof raw.styles === "object" && !Array.isArray(raw.styles) ? raw.styles as Record<string, unknown> : {};
    const styles: ProjectStyleSystem = {
      direction: normalizeStyleDirection(rawStyles.direction) || normalizeStyleDirection(raw.visualDirection) || fallback.styles.direction,
      colors: list(rawStyles.colors, fallback.styles.colors),
      typography: list(rawStyles.typography, fallback.styles.typography),
      spacing: list(rawStyles.spacing, fallback.styles.spacing),
      radii: list(rawStyles.radii, fallback.styles.radii),
      shadows: list(rawStyles.shadows, fallback.styles.shadows),
      layoutPrinciples: list(rawStyles.layoutPrinciples, fallback.styles.layoutPrinciples),
      motion: list(rawStyles.motion, fallback.styles.motion),
      responsive: list(rawStyles.responsive, fallback.styles.responsive),
      accessibility: list(rawStyles.accessibility, fallback.styles.accessibility),
      avoid: list(rawStyles.avoid, fallback.styles.avoid),
    };

    const candidate: ProjectPlan = {
      ...fallback,
      siteGoal: clean(raw.siteGoal, fallback.siteGoal),
      audience: clean(raw.audience, fallback.audience),
      pages: sitemap.map((page) => page.name),
      features: list(raw.features, fallback.features),
      sitemap,
      flows,
      components,
      styles,
      visualDirection: normalizeStyleDirection(raw.visualDirection) || styles.direction,
      backendRequired: resolvedBackendRequired(raw.backendRequired),
      slices,
      acceptanceCriteria: list(raw.acceptanceCriteria, fallback.acceptanceCriteria),
    };
    const authoritativeCandidate = applyFrozenAuthority(candidate);
    const validation = validateProjectPlanCoverage(authoritativeCandidate, brief);
    if (!validation.valid) return selectFallback(validation.issues.join(" "), validation);
    const framingRepair = artifact.framed ? null : artifact.framingRepair;
    const foundationRepair = authoritativeCandidate !== candidate
      ? "reapplied frozen Product Map and Global Style System authority"
      : null;
    const repairReason = [framingRepair, parsedJson.repairSummary, foundationRepair].filter(Boolean).join("; ") || null;
    return {
      plan: authoritativeCandidate,
      source: repairReason ? "repaired" : "model",
      fallbackReason: null,
      repairReason,
      validation,
      retryRecommended: false,
    };
  } catch (error) {
    return selectFallback(`Planner project-plan JSON could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parseProjectPlan(answer: string, brief: string, template = ""): ProjectPlan {
  return parseProjectPlanResult(answer, brief, template).plan;
}

export function projectPlanRepairPrompt(result: ProjectPlanParseResult): string {
  const required = result.validation.explicitRequiredPages;
  const capabilities = result.validation.requiredCapabilities;
  return [
    "The previous machine-readable project plan failed semantic coverage and must be regenerated.",
    result.fallbackReason ? `Failure: ${result.fallbackReason}` : "",
    required.length ? `Explicit required pages/screens: ${required.join(", ")}.` : "",
    capabilities.length ? `Required product capabilities: ${capabilities.join(", ")}.` : "",
    result.validation.missingCapabilities.length ? `Capabilities missing from the rejected plan: ${result.validation.missingCapabilities.join(", ")}.` : "",
    result.validation.contradictions.length ? `Brief/plan contradictions to remove:\n- ${result.validation.contradictions.join("\n- ")}` : "",
    "Every explicitly required page must appear in the rough sitemap and in the ordered page queue. Required capabilities must be represented by the relevant page purpose or queue boundary, but do not invent detailed future components or page acceptance criteria before that page is active.",
    "Internal applications must use application-oriented slices; do not use homepage/hero/marketing slices for dashboards or operations tools.",
    "Return the complete corrected plan and end with exactly one valid <borg-project-plan>...</borg-project-plan> block.",
  ].filter(Boolean).join("\n\n");
}

export type ProjectPlanDelta = {
  fromRevision: number;
  toRevision: number;
  addedPages: string[];
  removedPages: string[];
  changedPages: string[];
  addedSlices: string[];
  removedSlices: string[];
  changedSlices: string[];
};

export function projectPlanDelta(previous: ProjectPlan, next: ProjectPlan): ProjectPlanDelta {
  const previousPages = new Map(previous.sitemap.map((page) => [page.id, page]));
  const nextPages = new Map(next.sitemap.map((page) => [page.id, page]));
  const previousSlices = new Map(previous.slices.map((slice) => [slice.id, slice]));
  const nextSlices = new Map(next.slices.map((slice) => [slice.id, slice]));
  const changed = <T>(a: T, b: T) => JSON.stringify(a) !== JSON.stringify(b);
  return {
    fromRevision: previous.revision,
    toRevision: next.revision,
    addedPages: [...nextPages.keys()].filter((id) => !previousPages.has(id)),
    removedPages: [...previousPages.keys()].filter((id) => !nextPages.has(id)),
    changedPages: [...nextPages.keys()].filter((id) => previousPages.has(id) && changed(previousPages.get(id), nextPages.get(id))),
    addedSlices: [...nextSlices.keys()].filter((id) => !previousSlices.has(id)),
    removedSlices: [...previousSlices.keys()].filter((id) => !nextSlices.has(id)),
    changedSlices: [...nextSlices.keys()].filter((id) => previousSlices.has(id) && changed(previousSlices.get(id), nextSlices.get(id))),
  };
}

export function projectPlanRevisionPrompt(input: {
  brief: string;
  currentPlan: ProjectPlan;
  currentSliceIndex: number;
  conflictReason: string;
  review: unknown;
}): string {
  const currentSlice = input.currentPlan.slices[input.currentSliceIndex] ?? null;
  return [
    "BOUNDED PROJECT PLAN REVISION. The current approved frontend plan cannot legally satisfy the independent product-quality review. Revise the plan; do not implement code.",
    `Original brief:\n${input.brief.slice(0, 16_000)}`,
    `Current approved plan revision ${input.currentPlan.revision}:\n${JSON.stringify(input.currentPlan).slice(0, 40_000)}`,
    currentSlice ? `Current in-progress slice [${currentSlice.id}] ${currentSlice.title}: ${currentSlice.outcome}\nScope: ${currentSlice.scope.join("; ")}` : "",
    `Scope conflict:\n${input.conflictReason.slice(0, 6_000)}`,
    `Visual/Product review evidence:\n${JSON.stringify(input.review).slice(0, 24_000)}`,
    "Preserve already-completed work. Do not renumber, rename, or delete slices that are before the current in-progress slice unless the brief is impossible to satisfy otherwise.",
    currentSlice ? `Preserve the current slice id "${currentSlice.id}" when possible so Core can resume the existing worktree at the same logical boundary. You may expand its outcome/scope when the review proves that its existing boundary is invalid.` : "",
    "Revise only the sitemap, component inventory, style system, capabilities, and current/future slices needed to resolve the demonstrated conflict.",
    "The revised plan must still cover every explicit page and capability in the original brief. Internal applications must not regress into homepage/hero/marketing-site slice structures.",
    "Return a complete replacement <borg-project-plan> block, not a patch or prose-only delta.",
    projectPlanningPrompt(input.brief),
  ].filter(Boolean).join("\n\n");
}

export function projectPlanningPrompt(brief: string): string {
  return `OUTER WEBSITE BOOTSTRAP PLAN. Establish enough durable project authority to begin progressive page implementation. Do not implement anything and do not design the complete future website.

Your plan has three first-class structure artifacts:
1. ROUGH SITEMAP + USER FLOWS: enumerate likely routes in build order with stable ids, routes, short purposes, and a few section hints. Keep page componentIds and page acceptanceCriteria empty until the page slice is active.
2. GLOBAL STYLE SYSTEM: define site-wide visual rules independently from any single page: color roles, typography, spacing, radii, shadows, layout principles, motion, responsive behavior, accessibility, and explicit anti-patterns.
3. PAGE QUEUE: create bounded slices in page order. Slice 1 is the homepage/primary entry page. Future page details are intentionally resolved later from the rough sitemap, styles, and the components already evidenced by implemented pages.

Do not invent a complete component inventory. Components emerge from active page slices and are registered after verified implementation. Include a final cross-page frontend completion review slice. Every page slice must have one concrete user-visible outcome and fit in one bounded implementation/verification session.

End your response with exactly one machine-readable block using this shape:
<borg-project-plan>{"siteGoal":"...","audience":"...","pages":["Home"],"features":["..."],"sitemap":[{"id":"home","name":"Home","route":"/","purpose":"...","sections":["Navigation","Hero"],"componentIds":[],"acceptanceCriteria":[]}],"flows":[{"id":"primary","name":"Primary journey","purpose":"...","steps":["home","detail"]}],"components":[],"styles":{"direction":"...","colors":["..."],"typography":["..."],"spacing":["..."],"radii":["..."],"shadows":["..."],"layoutPrinciples":["..."],"motion":["..."],"responsive":["..."],"accessibility":["..."],"avoid":["..."]},"visualDirection":"...","backendRequired":false,"slices":[{"id":"home","title":"Homepage","outcome":"...","scope":["Home"],"acceptanceCriteria":["... "]}],"acceptanceCriteria":["..."]}</borg-project-plan>

The only project files authorized during PLAN are planning documents under .localcode/build/**/*.md, persisted by BORG after your response. Do not create source, component, style, asset, configuration, backend, API, auth, or database files; do not run builds, tests, previews, or verification. Brief: ${brief}`;
}

export function persistProposedProjectPlan(
  root: string,
  brief: string,
  plan: ProjectPlan,
  taskId: string,
  options: { coverage?: PlanCoverageReport; currentSlice?: number; revisionReason?: string } = {},
) {
  const dir = docsDirectory(root);
  mkdirSync(dir, { recursive: true });
  const proposed = { ...plan, status: "proposed" as const, approvedAt: null };
  const coverage = options.coverage ?? validateProjectPlanCoverage(proposed, brief);
  if (!coverage.valid) throw new Error(`Cannot persist an invalid project plan: ${coverage.issues.join(" ")}`);
  writeFileSync(join(dir, "README.md"), "# Build docs\n\n- [Product brief](brief.md)\n- [Plan coverage report](plan-coverage.md)\n- [Approved design brief](design-brief.md)\n- [Site map](site-map.md)\n- [Planned components](components.md)\n- [Global style system](styles.md)\n- [Pages registry](pages.json)\n- [Components registry](components.json)\n- [Frontend phase plan](plan.md)\n- [Frontend workflow state](workflow.md)\n- [Current slice](current-slice.md)\n- [Current slice plan](current-plan.md)\n- [Decisions and feedback](decisions.md)\n- [Progress](progress.md)\n- [Verification evidence](verification.md)\n- [Known issues](known-issues.md)\n- [Data and action contract](data-contract.md)\n- [Next-session handoff](handoff.md)\n- [Completed session history](history.md)\n\nThese documents are a generated knowledge projection of the durable SQLite workflow state. SQLite owns progression; these files provide portable, inspectable context for slice sessions and may be rebuilt from the workflow record. Slice sessions inherit the approved design brief and phase plan, then load only targeted handoff and source context instead of replaying prior conversations.\n");
  writeFileSync(join(dir, "brief.md"), `# Product brief\n\n${brief.trim()}\n`);
  writeFileSync(join(dir, "plan-coverage.json"), JSON.stringify(coverage, null, 2) + "\n");
  writeFileSync(join(dir, "plan-coverage.md"), [
    "# Plan coverage report",
    "",
    `Status: **${coverage.valid ? "pass" : "fail"}**`,
    "",
    `Explicit required pages: ${coverage.explicitRequiredPages.join(", ") || "None extracted"}`,
    `Missing pages: ${coverage.missingPages.join(", ") || "None"}`,
    `Missing slice coverage: ${coverage.missingSliceCoverage.join(", ") || "None"}`,
    `Required capabilities: ${coverage.requiredCapabilities.join(", ") || "None extracted"}`,
    `Missing capabilities: ${coverage.missingCapabilities.join(", ") || "None"}`,
    "",
    "## Contradictions",
    ...(coverage.contradictions.length ? coverage.contradictions.map((item) => `- ${item}`) : ["- None"]),
    "",
    "## Issues",
    ...(coverage.issues.length ? coverage.issues.map((item) => `- ${item}`) : ["- None"]),
    "",
    ...(options.revisionReason ? ["## Revision reason", "", options.revisionReason.slice(0, 4_000), ""] : []),
  ].join("\n"));
  writeFileSync(join(dir, "site-map.md"), `# Site map\n\n${proposed.sitemap.map((page) => `## ${page.name}\n\n- ID: \`${page.id}\`\n- Route: \`${page.route}\`\n- Purpose: ${page.purpose}\n- Sections: ${page.sections.join("; ") || "To be resolved during implementation"}\n- Components: ${page.componentIds.join(", ") || "None assigned"}\n- Acceptance: ${page.acceptanceCriteria.join("; ")}`).join("\n\n")}\n\n## User journeys\n\n${(proposed.flows ?? []).length ? (proposed.flows ?? []).map((flow) => `- **${flow.name}** — ${flow.steps.join(" → ")}\n  - ${flow.purpose}`).join("\n") : "- No multi-page journeys required."}\n`);
  writeFileSync(join(dir, "components.md"), `# Planned components\n\n${proposed.components.map((component) => `## ${component.name}\n\n- ID: \`${component.id}\`\n- Kind: ${component.kind}\n- Purpose: ${component.purpose}\n- Used by: ${component.usedBy.join(", ") || "shared/global"}\n- Variants: ${component.variants.join(", ") || "default"}\n- Acceptance: ${component.acceptanceCriteria.join("; ")}`).join("\n\n")}\n`);
  writeFileSync(join(dir, "styles.md"), `# Global style system\n\n## Direction\n\n${proposed.styles.direction}\n\n## Colors\n${proposed.styles.colors.map((item) => `- ${item}`).join("\n")}\n\n## Typography\n${proposed.styles.typography.map((item) => `- ${item}`).join("\n")}\n\n## Spacing\n${proposed.styles.spacing.map((item) => `- ${item}`).join("\n")}\n\n## Radii\n${proposed.styles.radii.map((item) => `- ${item}`).join("\n")}\n\n## Shadows\n${proposed.styles.shadows.map((item) => `- ${item}`).join("\n")}\n\n## Layout principles\n${proposed.styles.layoutPrinciples.map((item) => `- ${item}`).join("\n")}\n\n## Motion\n${proposed.styles.motion.map((item) => `- ${item}`).join("\n")}\n\n## Responsive\n${proposed.styles.responsive.map((item) => `- ${item}`).join("\n")}\n\n## Accessibility\n${proposed.styles.accessibility.map((item) => `- ${item}`).join("\n")}\n\n## Avoid\n${proposed.styles.avoid.map((item) => `- ${item}`).join("\n")}\n`);
  initializeProjectModel(root, proposed);
  writeFileSync(join(dir, "plan.md"), planMarkdown(proposed));
  writeFileSync(join(dir, "current-slice.md"), "# Current slice\n\nWaiting for approval of the frontend phase plan.\n");
  writeFileSync(join(dir, "progress.md"), `# Progress\n\nPhase: **Frontend**\n\nPlan revision: ${proposed.revision}\n\nStatus: awaiting plan approval\n`);
  if (!existsSync(join(dir, "decisions.md"))) writeFileSync(join(dir, "decisions.md"), "# Decisions and feedback\n");
  if (!existsSync(join(dir, "verification.md"))) writeFileSync(join(dir, "verification.md"), "# Verification evidence\n");
  if (!existsSync(join(dir, "known-issues.md"))) writeFileSync(join(dir, "known-issues.md"), "# Known issues\n");
  if (!existsSync(join(dir, "data-contract.md"))) writeFileSync(join(dir, "data-contract.md"), "# Data and action contract\n\nRecord frontend entities, fields, state transitions, actions, and persistence needs as screens are built.\n");
  if (!existsSync(join(dir, "history.md"))) writeFileSync(join(dir, "history.md"), "# Completed session history\n");
  writeFileSync(join(dir, "handoff.md"), `# Next-session handoff\n\nPlanning task: ${taskId}\n\nThe frontend phase plan is proposed and waiting for user approval. No implementation is authorized yet.\n`);
  const projected = stateFromPlan(proposed, brief, "plan_pending", taskId);
  if (Number.isInteger(options.currentSlice)) {
    projected.current = Math.max(0, Math.min(options.currentSlice!, Math.max(0, proposed.slices.length - 1)));
    projected.currentTitle = proposed.slices[projected.current]?.title ?? projected.currentTitle;
  }
  writeState(root, projected);
  setFrontendWorkflowStage(root, "planning", { currentSlice: projected.current, totalSlices: proposed.slices.length, taskId, detail: options.currentSlice === undefined ? "Frontend phase plan is proposed and waiting for approval." : `Plan revision ${proposed.revision} is proposed for the preserved slice ${projected.current + 1} boundary and waiting for approval.` });
  return proposed;
}

export function approveProjectPlan(root: string, taskId: string, authoritativePlan?: ProjectPlan) {
  const plan = authoritativePlan ?? readProjectPlan(root);
  const state = readSliceState(root);
  if (!plan) throw new Error("No proposed project plan exists.");
  const approved: ProjectPlan = { ...plan, status: "approved", approvedAt: new Date().toISOString() };
  initializeProjectModel(root, approved);
  writeFileSync(join(docsDirectory(root), "plan.md"), planMarkdown(approved));
  const next = stateFromPlan(approved, state?.brief || approved.siteGoal, "ready", taskId, state);
  writeState(root, next);
  const resumeSlice = approved.slices[next.current] ?? approved.slices[0];
  writeFileSync(join(docsDirectory(root), "current-slice.md"), `# Current slice\n\nReady to ${next.current > 0 || approved.revision > 1 ? "resume" : "start"} **${resumeSlice.title}**.\n\nOutcome: ${resumeSlice.outcome}\n`);
  writeFileSync(join(docsDirectory(root), "progress.md"), `# Progress\n\nPhase: **Frontend**\n\nPlan revision: ${approved.revision}\n\nStatus: approved; ready for slice ${next.current + 1} of ${approved.slices.length}\n`);
  writeFileSync(join(docsDirectory(root), "decisions.md"), `${safeRead(join(docsDirectory(root), "decisions.md"))}\n## ${new Date().toISOString()} — frontend plan approved\n\nApproved revision ${approved.revision} with ${approved.slices.length} slices.\n`);
  setFrontendWorkflowStage(root, "plan_approved", { currentSlice: next.current, totalSlices: approved.slices.length, taskId, detail: next.current > 0 || approved.revision > 1 ? `Plan revision ${approved.revision} approved. The server will resume slice ${next.current + 1} in the existing workflow boundary.` : "Plan approved. The server owns the transition into slice 1." });
  return { plan: approved, state: next };
}

export function currentSlice(plan: ProjectPlan, state: SliceState) {
  return plan.slices[Math.max(0, Math.min(state.current, plan.slices.length - 1))];
}

export function prepareSlice(
  root: string,
  brief: string,
  action: SliceAction,
  feedback: string,
  taskId: string,
  approvedPlan = "",
  authority?: { plan: ProjectPlan; state: SliceState },
): SliceState {
  const plan = authority?.plan ?? readProjectPlan(root);
  const previous = authority?.state ?? readSliceState(root);
  if (!plan) throw new Error("Approve the frontend phase plan before starting a slice.");
  if (!previous) throw new Error("Frontend project state is missing.");
  if (previous.status === "frontend_complete" || plan.status === "frontend_complete") throw new Error("Frontend is complete.");
  if (plan.status !== "approved") throw new Error("Approve the frontend phase plan before starting a slice.");
  if (!authority) {
    if (action === "initial" && previous.status !== "ready") throw new Error("The first slice is not ready to start.");
    if ((action === "advance" || action === "revise") && previous.status !== "awaiting_feedback") throw new Error("Review the completed slice before continuing.");
  }
  // With durable authority, Core has already selected the exact slice. This writer
  // projects that selection and must never advance the index on its own.
  const current = authority ? previous.current : action === "advance" ? Math.min(previous.current + 1, plan.slices.length - 1) : previous.current;
  const slice = plan.slices[current];
  const next: SliceState = {
    ...previous,
    current,
    total: plan.slices.length,
    currentTitle: slice.title,
    status: "working",
    lastTaskId: taskId,
    feedback: feedback.trim() ? [...previous.feedback, feedback.trim().slice(0, 4000)] : previous.feedback,
  };
  const dir = docsDirectory(root);
  writeState(root, next);
  const planText = `# Approved mini-plan: ${slice.title}\n\nOutcome: ${slice.outcome}\n\n## Scope\n${slice.scope.map((item) => `- ${item}`).join("\n")}\n\n## Slice acceptance\n${slice.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}\n\n## Architect execution notes\n\n${approvedPlan.trim().slice(0, 20_000) || "Implement only the approved slice outcome."}\n`;
  writeFileSync(join(dir, "current-plan.md"), planText);
  writeFileSync(join(dir, "current-slice.md"), `# Current slice\n\nSlice ${current + 1} of ${plan.slices.length}: **${slice.title}**\n\nOutcome: ${slice.outcome}\n\nStatus: working\n`);
  if (existsSync(join(dir, "plans")) && !lstatSync(join(dir, "plans")).isDirectory()) throw new Error("Plan archive is not a normal directory.");
  mkdirSync(join(dir, "plans"), { recursive: true });
  writeFileSync(join(dir, "plans", `${slice.id}-${taskId}.md`), planText);
  if (feedback.trim()) writeFileSync(join(dir, "decisions.md"), `${safeRead(join(dir, "decisions.md"))}\n## ${new Date().toISOString()} — ${action}\n\n${feedback.trim().slice(0, 4000)}\n`);
  writeFileSync(join(dir, "handoff.md"), `# Next-session handoff\n\nCurrent task: ${taskId}\n\nImplement only **${slice.title}**. ${slice.outcome}\n\nUse the approved phase plan as scope authority. Read only the files needed for this slice and the relevant decisions/handoff; do not restart repository discovery or create a new project plan.\n`);
  setFrontendWorkflowStage(root, "slice_planning", { currentSlice: current, totalSlices: plan.slices.length, taskId, detail: `Preparing ${slice.title} as a bounded implementation mini-loop.` });
  return next;
}

export function markSliceReady(
  root: string,
  taskId: string,
  summary: string,
  authority?: { plan: ProjectPlan; state: SliceState },
): SliceState | null {
  const plan = authority?.plan ?? readProjectPlan(root);
  const state = authority?.state ?? readSliceState(root);
  if (!plan || !state || state.lastTaskId !== taskId) return null;
  // Verification proves the slice is checkpoint-ready; it does not complete the
  // slice or frontend phase. Only WorkflowEngine.completeDelivery may advance the
  // durable project workflow, after which projectDeliveredFrontendCheckpoint()
  // updates these generated docs.
  const next: SliceState = { ...state, status: "awaiting_feedback" };
  writeState(root, next);
  const dir = docsDirectory(root);
  const slice = currentSlice(plan, state);
  const finalSlice = state.current === plan.slices.length - 1;
  writeFileSync(join(dir, "progress.md"), `${safeRead(join(dir, "progress.md"))}\n## ${slice.title}\n\nStatus: verified; checkpoint pending\n\n${summary.slice(0, 3000)}\n`);
  writeFileSync(join(dir, "verification.md"), `${safeRead(join(dir, "verification.md"))}\n## ${slice.title} — ${taskId}\n\n${summary.slice(0, 5000)}\n`);
  writeFileSync(join(dir, "handoff.md"), `# Next-session handoff\n\nVerified: **${slice.title}**\n\n${summary.slice(0, 3000)}\n\n${finalSlice ? "The final frontend slice is verified, but the frontend phase is not complete until Core checkpoints delivery." : "The slice is verified, but the next slice is not authorized until Core checkpoints delivery and schedules it."}\n`);
  writeFileSync(join(dir, "history.md"), `${safeRead(join(dir, "history.md"))}\n## ${slice.title} — ${taskId}\n\nVerified; checkpoint pending.\n\n${summary.slice(0, 3000)}\n`);
  setFrontendWorkflowStage(root, "awaiting_feedback", {
    currentSlice: state.current,
    totalSlices: plan.slices.length,
    taskId,
    detail: `${slice.title} is verified. Core must checkpoint delivery before project progression changes.`,
  });
  return next;
}

export function projectDeliveredFrontendCheckpoint(root: string, workflow: WorkflowState): SliceState | null {
  const plan = workflow.projectPlan as ProjectPlan | null;
  if (workflow.loop !== "slice" || workflow.phase !== "frontend" || !plan || workflow.sliceIndex === null) return null;
  const slice = plan.slices[workflow.sliceIndex];
  if (!slice) return null;

  const complete = plan.status === "frontend_complete";
  const next: SliceState = {
    version: 2,
    current: workflow.sliceIndex,
    total: plan.slices.length,
    currentTitle: workflow.sliceTitle ?? slice.title,
    status: complete ? "frontend_complete" : "awaiting_feedback",
    brief: plan.siteGoal,
    lastTaskId: workflow.taskId,
    feedback: workflow.feedback,
    planRevision: plan.revision,
    backendRequired: plan.backendRequired,
  };

  const dir = docsDirectory(root);
  writeState(root, next);
  writeFileSync(join(dir, "plan.md"), planMarkdown(plan));
  writeFileSync(join(dir, "current-slice.md"), complete
    ? `# Current slice\n\nFrontend complete after checkpointing **${slice.title}**.\n`
    : `# Current slice\n\nCheckpointed **${slice.title}**. Core scheduled the next approved slice.\n`);
  writeFileSync(join(dir, "progress.md"), `${safeRead(join(dir, "progress.md"))}\n## Checkpoint — ${slice.title}\n\nStatus: checkpointed\n\nWorkflow version: ${workflow.version}\n\nNext action: ${workflow.nextAction}\n`);
  writeFileSync(join(dir, "handoff.md"), `# Next-session handoff\n\nCheckpointed: **${slice.title}**\n\n${complete
    ? (plan.backendRequired
      ? "The approved frontend phase is complete. Backend planning is eligible when the operator chooses to continue."
      : "The approved frontend phase is complete. No backend phase is required by the approved plan.")
    : "Core has durably scheduled the next approved frontend slice. Continue only from that Core command; do not rediscover or re-plan the project."}\n`);
  setFrontendWorkflowStage(root, complete ? "frontend_complete" : "awaiting_feedback", {
    currentSlice: workflow.sliceIndex,
    totalSlices: plan.slices.length,
    taskId: workflow.taskId,
    detail: complete
      ? "All approved frontend slices are checkpointed and the frontend phase is complete."
      : `${slice.title} is checkpointed and Core scheduled the next approved slice.`,
  });
  return next;
}

export function readProjectDocs(root: string): ProjectDoc[] {
  let dir: string;
  try { dir = docsDirectory(root); } catch { return []; }
  const names = ["README.md", "brief.md", "plan-coverage.md", designBriefFile, "site-map.md", "components.md", "styles.md", "plan.md", "current-slice.md", "current-plan.md", "decisions.md", "progress.md", "verification.md", "known-issues.md", "data-contract.md", "handoff.md", "history.md", stateFile, workflowFile];
  if (existsSync(join(dir, "plans")) && lstatSync(join(dir, "plans")).isDirectory()) names.push(...readdirSync(join(dir, "plans")).filter((name) => name.endsWith(".md")).sort().map((name) => `plans/${name}`));
  return names.flatMap((name) => {
    const path = join(dir, name);
    return existsSync(path) ? [{ path: `${folder}/${name}`, title: name.replace(/\.md$/, "").replaceAll("-", " "), content: safeRead(path).slice(0, 100_000) }] : [];
  });
}

export function slicePlanningPrompt(plan: ProjectPlan, state: SliceState): string {
  const slice = currentSlice(plan, state);
  const page = plan.sitemap.find((candidate) => candidate.id === slice.id)
    ?? plan.sitemap.find((candidate) => slice.scope.some((item) => normalizedRequirement(item).includes(normalizedRequirement(candidate.name))))
    ?? plan.sitemap[0];
  return `MINI LOOP — PAGE SLICE ${state.current + 1}/${plan.slices.length}: ${slice.title}. Current page: ${page?.name ?? "primary page"} (${page?.route ?? "/"}). Approved outcome: ${slice.outcome}

This is the detailed planning step for the current page only. The outer project plan intentionally contains a rough sitemap and global style authority, not a speculative component inventory. Load the rough sitemap, approved global styles, current page purpose/section hints, existing project registries, relevant decisions, latest handoff, and only the source files needed for this page.

Decide for this page:
- section order and page-specific composition;
- components to reuse from the registry;
- new components justified by this page, with stable ids and responsibilities;
- interactions, responsive behavior, accessibility behavior, and page acceptance criteria;
- any data/action contract needed without inventing backend work.

Produce a concise page implementation plan for this slice only. Update the global component registry only with components evidenced by this page. Do not rediscover the whole repository, redesign the phase plan, expand to future pages, mutate source, or run commands, previews, builds, tests, or verification during this architect pass. BORG may persist planning Markdown under .localcode/build/**/*.md through its dedicated docs path.`;
}

export function slicePrompt(plan: ProjectPlan, state: SliceState, availableTools: string[] = []): string {
  const slice = currentSlice(plan, state);
  return `MINI LOOP — IMPLEMENT SLICE ${state.current + 1}/${plan.slices.length}: ${slice.title}. Outcome: ${slice.outcome} Scope: ${slice.scope.join("; ")}. Acceptance: ${slice.acceptanceCriteria.join("; ")}. Do not create a new project plan or reread the whole repository. Read only relevant files and the compact build docs/handoff. Implement this slice, keep basic responsive and accessible behavior working, run type/build/relevant interaction checks plus real browser review, and update durable docs with evidence. The desktop runtime checkpoints verified slices and starts the next approved slice automatically. Backend/API/auth/database work is forbidden during the frontend phase except documenting the data/action contract. Available implementation tools: ${availableTools.length ? availableTools.join(", ") : "use only the tools actually provided by the runtime"}.`;
}
