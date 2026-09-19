import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync as writeRawFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { initializeProjectModel } from "./project-model.ts";

export type SliceAction = "initial" | "revise" | "advance";
export type ProjectSlice = {
  id: string;
  title: string;
  outcome: string;
  scope: string[];
  acceptanceCriteria: string[];
};
export type ProjectPlan = {
  version: 2;
  revision: number;
  status: "proposed" | "approved" | "frontend_complete";
  phase: "frontend";
  siteGoal: string;
  audience: string;
  pages: string[];
  features: string[];
  visualDirection: string;
  backendRequired: boolean;
  slices: ProjectSlice[];
  acceptanceCriteria: string[];
  proposedAt: string;
  approvedAt: string | null;
};
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
  return next || `slice-${index + 1}`;
}
function writeState(root: string, state: SliceState) {
  const dir = docsDirectory(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(statePath(root), `# BORG build state\n\n\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\`\n`);
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
  writeFileSync(workflowPath(root), `# Frontend workflow\n\nStage: **${state.stage.replaceAll("_", " ")}**\n\n\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\`\n`);
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
  return `# Approved frontend phase plan\n\nStatus: **${plan.status.replaceAll("_", " ")}** · Revision ${plan.revision}\n\n## Site goal\n\n${plan.siteGoal}\n\n## Audience\n\n${plan.audience}\n\n## Visual direction\n\n${plan.visualDirection}\n\n## Pages\n\n${plan.pages.map((item) => `- ${item}`).join("\n") || "- Single page"}\n\n## Features\n\n${plan.features.map((item) => `- ${item}`).join("\n") || "- Content and navigation"}\n\n## Frontend slices\n\n${plan.slices.map((slice, index) => `${index + 1}. **${slice.title}** — ${slice.outcome}\n   - Scope: ${slice.scope.join("; ") || "As defined by the approved brief"}\n   - Acceptance: ${slice.acceptanceCriteria.join("; ") || "Working preview and relevant verification"}`).join("\n")}\n\n## Frontend completion gate\n\n${plan.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}\n\n## Backend phase\n\n${plan.backendRequired ? "Required after frontend approval because the brief needs server features, stored data, accounts, or integrations." : "Not required by the approved brief. The site may be marked complete after the frontend completion gate passes."}\n\n<borg-project-plan>${JSON.stringify(plan)}</borg-project-plan>\n`;
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
    const value = JSON.parse(match[1]) as ProjectPlan;
    return value.version === 2 && Array.isArray(value.slices) && value.slices.length > 0 ? value : null;
  } catch { return null; }
}

export function fallbackProjectPlan(brief: string, template = ""): ProjectPlan {
  const text = brief.toLowerCase();
  const commerce = /e.?commerce|commerce|marketplace|shop|store|catalog|product|cart|checkout/.test(`${template} ${text}`);
  const dashboard = /dashboard|portal|admin|operations|analytics/.test(`${template} ${text}`);
  const contentHeavy = /blog|content|news|docs|documentation|magazine/.test(`${template} ${text}`);
  const social = /social|creator|feed|follow|favorite|wishlist|review|trending|recommend/.test(text);
  const seller = /seller|merchant|storefront|inventory|sku/.test(text);
  const admin = /admin|moderation|role|permission/.test(text);
  const accounts = /account|auth|login|sign.?up|profile|order|wishlist/.test(text);
  const backendRequired = /account|auth|login|database|persist|checkout|payment|booking|order|cart|upload|message|api|integration|dashboard|seller|admin/.test(text);
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
  } else {
    slices.push(
      { id: "foundation", title: "Homepage shell and hero", outcome: "The homepage navigation, visual foundation, and hero are polished and usable in the preview.", scope: ["design tokens and layout shell", "header and navigation", "homepage hero", "basic responsive and accessible behavior"], acceptanceCriteria: ["hero communicates the primary offer", "desktop and mobile layouts are usable", "visible navigation controls work"] },
      { id: "homepage-sections", title: contentHeavy ? "Homepage content and discovery sections" : "Homepage sections and calls to action", outcome: "The homepage sections below the hero form a complete, coherent page with working calls to action.", scope: ["approved homepage content sections", "reusable section components", "section imagery and copy", "calls to action and interaction states"], acceptanceCriteria: ["all approved homepage sections are present", "section components work across target viewports", "calls to action have a meaningful destination or state"] },
      { id: "content-flows", title: contentHeavy ? "Content structure and discovery" : "Remaining pages and interactions", outcome: "The remaining core pages, content, and interactions required by the brief work coherently.", scope: ["remaining core screens", "interaction states", "loading, empty, and error states where relevant"], acceptanceCriteria: ["approved pages are reachable", "core interactions work", "relevant states are represented"] },
    );
    if (dashboard) slices.push({ id: "secondary-flows", title: "Secondary flows and edge states", outcome: "Secondary user journeys and cross-screen behavior are complete enough for end-to-end browser review.", scope: ["secondary journeys", "navigation continuity", "edge and demonstration states"], acceptanceCriteria: ["key journeys can be exercised end to end", "no dead controls in approved scope"] });
  }

  slices.push({
    id: "frontend-review",
    title: "Frontend completion review",
    outcome: "The approved frontend passes responsive, accessibility, visual, build, browser, and interaction completion gates.",
    scope: ["responsive review", "accessibility review", "visual polish", "browser verification", "loading/empty/error states", "data/action contract", "cross-slice consistency"],
    acceptanceCriteria: ["typecheck and build pass", "key browser journeys pass", "mobile and desktop reviews pass", "accessibility and visual reviews are complete", "no obvious placeholder or dead-control quality remains"],
  });

  const pages = commerce
    ? ["Home", "Discovery", "Search", "Product", "Cart", "Checkout", "Order confirmation", "Account", ...(seller ? ["Seller storefront", "Seller dashboard"] : []), ...(admin ? ["Admin"] : [])]
    : ["Pages and routes required by the brief"];
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

export function parseProjectPlan(answer: string, brief: string, template = ""): ProjectPlan {
  const fallback = fallbackProjectPlan(brief, template);
  const match = answer.match(planMarker);
  if (!match) return fallback;
  try {
    const raw = JSON.parse(match[1]) as Record<string, unknown>;
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
    if (slices.length < 2) return fallback;
    return {
      ...fallback,
      siteGoal: clean(raw.siteGoal, fallback.siteGoal),
      audience: clean(raw.audience, fallback.audience),
      pages: list(raw.pages, fallback.pages),
      features: list(raw.features, fallback.features),
      visualDirection: clean(raw.visualDirection, fallback.visualDirection),
      backendRequired: typeof raw.backendRequired === "boolean" ? raw.backendRequired : fallback.backendRequired,
      slices,
      acceptanceCriteria: list(raw.acceptanceCriteria, fallback.acceptanceCriteria),
    };
  } catch { return fallback; }
}

export function projectPlanningPrompt(brief: string): string {
  return `OUTER WEBSITE PHASE PLAN. This is the one full planning loop for the frontend phase. Inspect the brief and approved repository context, then propose a tailored frontend slice plan. Do not implement anything. For a homepage, enumerate its actual sections and reusable components, then assign every section to an explicit slice scope. Put the shell and hero in the first slice, then plan the remaining homepage sections and interactions in subsequent bounded slices; do not hide the whole homepage under one generic slice. Include a final review slice. A marketplace or dashboard may need more slices. Every slice must have one concrete user-visible outcome and fit in one bounded implementation/verification session. Content and interactions come before dedicated final audits; basic responsive and accessible behavior is required from the first slice. End your response with exactly one machine-readable block using this shape:
<borg-project-plan>{"siteGoal":"...","audience":"...","pages":["..."],"features":["..."],"visualDirection":"...","backendRequired":false,"slices":[{"id":"...","title":"...","outcome":"...","scope":["..."],"acceptanceCriteria":["..."]}],"acceptanceCriteria":["..."]}</borg-project-plan>
The only project files authorized during PLAN are planning documents under .localcode/build/**/*.md, persisted by BORG after your response. Do not create source, component, style, asset, configuration, backend, API, auth, or database files; do not run builds, tests, previews, or verification. Brief: ${brief}`;
}

export function persistProposedProjectPlan(root: string, brief: string, plan: ProjectPlan, taskId: string) {
  const dir = docsDirectory(root);
  mkdirSync(dir, { recursive: true });
  const previousPlan = readProjectPlan(root);
  const proposed = { ...plan, revision: previousPlan ? previousPlan.revision + 1 : Math.max(1, plan.revision), status: "proposed" as const, approvedAt: null };
  writeFileSync(join(dir, "README.md"), "# Build docs\n\n- [Product brief](brief.md)\n- [Approved design brief](design-brief.md)\n- [Site map](site-map.md)\n- [Pages registry](pages.json)\n- [Components registry](components.json)\n- [Frontend phase plan](plan.md)\n- [Frontend workflow state](workflow.md)\n- [Current slice](current-slice.md)\n- [Current slice plan](current-plan.md)\n- [Decisions and feedback](decisions.md)\n- [Progress](progress.md)\n- [Verification evidence](verification.md)\n- [Known issues](known-issues.md)\n- [Data and action contract](data-contract.md)\n- [Next-session handoff](handoff.md)\n- [Completed session history](history.md)\n\nThese documents are a generated knowledge projection of the durable SQLite workflow state. SQLite owns progression; these files provide portable, inspectable context for slice sessions and may be rebuilt from the workflow record. Slice sessions inherit the approved design brief and phase plan, then load only targeted handoff and source context instead of replaying prior conversations.\n");
  writeFileSync(join(dir, "brief.md"), `# Product brief\n\n${brief.trim()}\n`);
  writeFileSync(join(dir, "site-map.md"), `# Site map\n\n${proposed.pages.map((page) => `- ${page}`).join("\n")}\n`);
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
  writeState(root, stateFromPlan(proposed, brief, "plan_pending", taskId));
  setFrontendWorkflowStage(root, "planning", { currentSlice: 0, totalSlices: proposed.slices.length, taskId, detail: "Frontend phase plan is proposed and waiting for approval." });
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
  writeFileSync(join(docsDirectory(root), "current-slice.md"), `# Current slice\n\nReady to start **${approved.slices[0].title}**.\n\nOutcome: ${approved.slices[0].outcome}\n`);
  writeFileSync(join(docsDirectory(root), "progress.md"), `# Progress\n\nPhase: **Frontend**\n\nPlan revision: ${approved.revision}\n\nStatus: approved; ready for slice 1 of ${approved.slices.length}\n`);
  writeFileSync(join(docsDirectory(root), "decisions.md"), `${safeRead(join(docsDirectory(root), "decisions.md"))}\n## ${new Date().toISOString()} — frontend plan approved\n\nApproved revision ${approved.revision} with ${approved.slices.length} slices.\n`);
  setFrontendWorkflowStage(root, "plan_approved", { currentSlice: 0, totalSlices: approved.slices.length, taskId, detail: "Plan approved. The server owns the transition into slice 1." });
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
  if (action === "initial" && previous.status !== "ready") throw new Error("The first slice is not ready to start.");
  if ((action === "advance" || action === "revise") && previous.status !== "awaiting_feedback") throw new Error("Review the completed slice before continuing.");
  const current = action === "advance" ? Math.min(previous.current + 1, plan.slices.length - 1) : previous.current;
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
  const complete = state.current === plan.slices.length - 1;
  const next: SliceState = { ...state, status: complete ? "frontend_complete" : "awaiting_feedback" };
  writeState(root, next);
  const dir = docsDirectory(root);
  const slice = currentSlice(plan, state);
  writeFileSync(join(dir, "progress.md"), `${safeRead(join(dir, "progress.md"))}\n## ${slice.title}\n\nStatus: ${next.status.replaceAll("_", " ")}\n\n${summary.slice(0, 3000)}\n`);
  writeFileSync(join(dir, "verification.md"), `${safeRead(join(dir, "verification.md"))}\n## ${slice.title} — ${taskId}\n\n${summary.slice(0, 5000)}\n`);
  writeFileSync(join(dir, "handoff.md"), `# Next-session handoff\n\nCompleted: **${slice.title}**\n\n${summary.slice(0, 3000)}\n\n${complete ? (plan.backendRequired ? "Frontend completion gate is ready for user review. Backend planning may begin only after approval." : "Frontend completion gate is ready for user review. No backend phase is required by the approved brief.") : "After the verified checkpoint, continue automatically with the next approved slice in a new mini-loop session using this handoff."}\n`);
  writeFileSync(join(dir, "history.md"), `${safeRead(join(dir, "history.md"))}\n## ${slice.title} — ${taskId}\n\n${summary.slice(0, 3000)}\n`);
  if (complete) {
    const completedPlan: ProjectPlan = { ...plan, status: "frontend_complete" };
    writeFileSync(join(dir, "plan.md"), planMarkdown(completedPlan));
  }
  setFrontendWorkflowStage(root, complete ? "frontend_complete" : "awaiting_feedback", {
    currentSlice: state.current,
    totalSlices: plan.slices.length,
    taskId,
    detail: complete ? "All approved frontend slices are complete." : `${slice.title} is verified and ready for an automatic checkpoint and next slice.`,
  });
  return next;
}

export function readProjectDocs(root: string): ProjectDoc[] {
  let dir: string;
  try { dir = docsDirectory(root); } catch { return []; }
  const names = ["README.md", "brief.md", designBriefFile, "site-map.md", "plan.md", "current-slice.md", "current-plan.md", "decisions.md", "progress.md", "verification.md", "known-issues.md", "data-contract.md", "handoff.md", "history.md", stateFile, workflowFile];
  if (existsSync(join(dir, "plans")) && lstatSync(join(dir, "plans")).isDirectory()) names.push(...readdirSync(join(dir, "plans")).filter((name) => name.endsWith(".md")).sort().map((name) => `plans/${name}`));
  return names.flatMap((name) => {
    const path = join(dir, name);
    return existsSync(path) ? [{ path: `${folder}/${name}`, title: name.replace(/\.md$/, "").replaceAll("-", " "), content: safeRead(path).slice(0, 100_000) }] : [];
  });
}

export function slicePlanningPrompt(plan: ProjectPlan, state: SliceState): string {
  const slice = currentSlice(plan, state);
  return `MINI LOOP — FRONTEND SLICE ${state.current + 1}/${plan.slices.length}: ${slice.title}. Approved outcome: ${slice.outcome} This is an internal execution loop inside the already-approved frontend phase plan. Do not rediscover the whole repository, redesign the phase plan, or expand scope. Load the approved phase plan, current slice, relevant decisions, latest handoff, and only the source files needed for this outcome. Produce a concise execution plan for this slice only; the desktop runtime will authorize execution from the outer plan approval. During this architect pass, do not mutate source/components/styles/assets/config/backend/API/auth/database files or run commands, previews, builds, tests, or verification. BORG may persist planning Markdown under .localcode/build/**/*.md through its dedicated docs path.`;
}

export function slicePrompt(plan: ProjectPlan, state: SliceState, availableTools: string[] = []): string {
  const slice = currentSlice(plan, state);
  return `MINI LOOP — IMPLEMENT SLICE ${state.current + 1}/${plan.slices.length}: ${slice.title}. Outcome: ${slice.outcome} Scope: ${slice.scope.join("; ")}. Acceptance: ${slice.acceptanceCriteria.join("; ")}. Do not create a new project plan or reread the whole repository. Read only relevant files and the compact build docs/handoff. Implement this slice, keep basic responsive and accessible behavior working, run type/build/relevant interaction checks plus real browser review, and update durable docs with evidence. The desktop runtime checkpoints verified slices and starts the next approved slice automatically. Backend/API/auth/database work is forbidden during the frontend phase except documenting the data/action contract. Available implementation tools: ${availableTools.length ? availableTools.join(", ") : "use only the tools actually provided by the runtime"}.`;
}
