import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import {
  ContextPackSchema,
  type ContextManifestItem,
  type ContextPack,
  type ContextScope,
} from "../../core/src/context-domain.ts";
import { readPersistedDesignBrief, readProjectPlan, readSliceState, type ProjectPlan, type SliceState } from "./slice-docs.ts";
import { readProjectModel, validateProjectSource } from "./project-model.ts";

export type ContextItem = ContextManifestItem;
export type CompiledContext = ContextPack;

type ContextAuthority = {
  plan: ProjectPlan;
  state?: SliceState;
  workflowVersion?: number | null;
};

type ContextSourceHint = string | { path: string; reason?: string };

type ContextBaseInput = {
  root: string;
  budgetCharacters?: number;
  productContract?: string;
  projectBrief?: string;
  sourceHints?: ContextSourceHint[];
  stage?: "planning" | "execution" | "repair";
};

export type ContextInput = ContextBaseInput & {
  phase: "frontend";
  sliceIndex: number;
  scope?: Extract<ContextScope, { type: "page" | "component" }> | null;
  authority?: ContextAuthority;
};

export type FocusedContextInput = ContextBaseInput & {
  scope: Extract<ContextScope, { type: "page" | "component" }>;
  authority?: { plan: ProjectPlan; workflowVersion?: number | null };
};

export type StyleContextInput = ContextBaseInput & {
  authority?: { plan: ProjectPlan; workflowVersion?: number | null };
};

type InternalInput = ContextBaseInput & {
  profileKind: "slice" | "page" | "component" | "styles";
  sliceIndex?: number | null;
  scope?: ContextScope | null;
  authority?: ContextAuthority;
};

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css", ".scss", ".sass", ".less", ".html"]);
const entrypoints = ["src/App.tsx", "src/App.jsx", "src/main.tsx", "src/main.jsx", "src/style.css", "src/styles.css", "app/page.tsx", "app/layout.tsx", "app/globals.css"];

function hash(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

function bounded(text: string, maximum: number) {
  const value = text.trim();
  return value.length <= maximum ? value : `${value.slice(0, maximum)}\n[Content compacted for this context pack.]`;
}

function wordSet(text: string) {
  return new Set(
    text.toLowerCase()
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 3 && !["frontend", "website", "working", "current", "slice", "page", "component", "review", "build"].includes(word)),
  );
}

function overlaps(left: Set<string>, right: Set<string>) {
  for (const word of left) if (right.has(word)) return true;
  return false;
}

function optionalProjection(root: string, name: string, maximum: number, tail = false) {
  const path = join(root, ".localcode", "build", name);
  if (!existsSync(path) || !lstatSync(path).isFile()) return null;
  const content = readFileSync(path, "utf8");
  return bounded(tail ? content.slice(-maximum) : content.slice(0, maximum), maximum);
}

function normalizeHints(root: string, hints: ContextSourceHint[] | undefined) {
  const values: Array<{ path: string; reason: string }> = [];
  for (const hint of hints ?? []) {
    const raw = typeof hint === "string" ? hint : hint.path;
    try {
      const path = validateProjectSource(root, raw);
      if (!sourceExtensions.has(extname(path).toLowerCase())) continue;
      if (!values.some((item) => item.path === path)) {
        values.push({
          path,
          reason: typeof hint === "string" ? "Repository-memory dependency or symbol hint" : hint.reason?.trim() || "Repository-memory dependency or symbol hint",
        });
      }
    } catch {
      // Invalid or escaped source hints are excluded rather than widening context.
    }
  }
  return values.slice(0, 12);
}

function contextAuthority(input: InternalInput) {
  const plan = input.authority?.plan ?? readProjectPlan(input.root);
  const state = input.authority?.state ?? (input.profileKind === "slice" ? readSliceState(input.root) : undefined);
  if (!plan || plan.status === "proposed") throw new Error("Approved frontend project state is missing. Repair the durable project plan before continuing.");
  if (input.profileKind === "slice" && !state) throw new Error("Durable frontend slice state is missing.");
  return {
    plan,
    state,
    authority: input.authority ? "workflow" as const : "legacy_projection" as const,
    workflowVersion: input.authority?.workflowVersion ?? null,
  };
}

function relatedRegistry(input: InternalInput, plan: ProjectPlan) {
  const model = readProjectModel(input.root);
  const scope = input.scope ?? null;
  const page = scope?.type === "page" ? model.pages.find((item) => item.id === scope.id) ?? null : null;
  const component = scope?.type === "component" ? model.components.find((item) => item.id === scope.id) ?? null : null;
  if (scope?.type === "page" && !page) throw new Error(`Unknown page scope: ${scope.id}`);
  if (scope?.type === "component" && !component) throw new Error(`Unknown component scope: ${scope.id}`);

  if (scope?.type === "styles") {
    const pages = model.pages.map((item) => ({
      id: item.id,
      name: item.name,
      route: item.route,
      purpose: item.purpose,
      components: item.components,
      status: item.status,
    }));
    const components = model.components.map((item) => ({
      id: item.id,
      name: item.name,
      kind: item.kind,
      purpose: item.purpose,
      usedBy: item.usedBy,
      variants: item.variants,
      status: item.status,
    }));
    const files = [...new Set([
      ...model.pages.flatMap((item) => item.files),
      ...model.components.flatMap((item) => item.files),
    ])].filter((path) => /(?:^|\/)(?:app|layout|theme|styles?|tokens?|globals?)(?:[./_-]|$)|\.(?:css|scss|sass|less)$/i.test(path));
    return { model, pages, components, explicitFiles: files };
  }

  if (page) {
    const direct = model.components.filter((item) => page.components.includes(item.id) || item.usedBy.includes(page.id));
    const dependencyIds = new Set(direct.flatMap((item) => item.dependencies));
    const components = [...direct];
    for (const candidate of model.components) {
      if (dependencyIds.has(candidate.id) && !components.some((item) => item.id === candidate.id)) components.push(candidate);
    }
    return {
      model,
      pages: [page],
      components,
      explicitFiles: [...new Set([...page.files, ...components.flatMap((item) => item.files)])],
    };
  }

  if (component) {
    const direct = [component, ...model.components.filter((item) => component.dependencies.includes(item.id))];
    const dependencyIds = new Set(direct.flatMap((item) => item.dependencies));
    const components = [...direct];
    for (const candidate of model.components) {
      if (dependencyIds.has(candidate.id) && !components.some((item) => item.id === candidate.id)) components.push(candidate);
    }
    const pages = model.pages.filter((item) => component.usedBy.includes(item.id) || item.components.includes(component.id));
    return {
      model,
      pages,
      components,
      explicitFiles: [...new Set([...pages.flatMap((item) => item.files), ...components.flatMap((item) => item.files)])],
    };
  }

  const sliceIndex = input.sliceIndex ?? 0;
  const slice = plan.slices[sliceIndex];
  if (!slice) throw new Error(`Frontend slice ${sliceIndex + 1} is not in the approved plan.`);
  const relevant = wordSet([slice.title, slice.outcome, ...slice.scope].join(" "));
  let pages = model.pages.filter((item) => overlaps(relevant, wordSet([item.name, item.purpose, ...item.sections].join(" "))));
  if (!pages.length && sliceIndex === 0 && model.pages.length) pages = [model.pages[0]];
  const components = model.components.filter((item) =>
    pages.some((candidate) => item.usedBy.includes(candidate.id))
    || overlaps(relevant, wordSet([item.name, item.purpose, ...item.variants].join(" "))),
  );
  const dependencyIds = new Set(components.flatMap((item) => item.dependencies));
  for (const candidate of model.components) {
    if (dependencyIds.has(candidate.id) && !components.some((item) => item.id === candidate.id)) components.push(candidate);
  }
  return {
    model,
    pages,
    components,
    explicitFiles: [...new Set([...pages.flatMap((item) => item.files), ...components.flatMap((item) => item.files)])],
  };
}

function compileContextPack(input: InternalInput): CompiledContext {
  const { plan, state, authority, workflowVersion } = contextAuthority(input);
  const registry = relatedRegistry(input, plan);
  const sliceIndex = input.profileKind === "slice" ? input.sliceIndex ?? state?.current ?? null : null;
  const slice = sliceIndex === null ? null : plan.slices[sliceIndex] ?? null;
  if (input.profileKind === "slice" && !slice) throw new Error("The selected frontend slice is missing from the approved plan.");

  const scope = input.scope ?? null;
  const profileId = input.profileKind === "slice"
    ? slice!.id
    : scope?.type === "styles"
      ? "styles:global"
      : `${scope!.type}:${scope!.id}`;
  const profile = {
    version: 1 as const,
    kind: input.profileKind,
    stage: input.stage ?? "planning",
    id: profileId,
    phase: "frontend" as const,
    planRevision: plan.revision,
    workflowVersion,
    sliceIndex,
    sliceId: slice?.id ?? null,
    scope,
  };

  const budgetCharacters = Math.max(8_000, Math.min(64_000, input.budgetCharacters ?? 48_000));
  const manifest: ContextManifestItem[] = [];
  const sections: string[] = [];
  let characters = 0;

  const add = (
    kind: ContextManifestItem["kind"],
    path: string,
    reason: string,
    content: string,
    required = false,
  ) => {
    const clean = content.trim();
    if (!clean) return false;
    const section = `--- ${path} (${reason}) ---\n${clean}\n`;
    if (characters + section.length > budgetCharacters) {
      if (required) throw new Error(`Context budget is too small for required project state: ${path}.`);
      return false;
    }
    sections.push(section);
    characters += section.length;
    manifest.push({ kind, path, reason, characters: section.length, sha256: hash(section), required });
    return true;
  };

  if (input.productContract?.trim()) {
    add("contract", "@borg/website-product-contract", "Pinned website product contract", bounded(input.productContract, 8_000), true);
  }

  const authoritativeBrief = input.projectBrief?.trim() ? bounded(input.projectBrief, 4_000) : "";
  const projectBrief = authoritativeBrief || optionalProjection(input.root, "brief.md", 4_000);
  if (projectBrief) add(authoritativeBrief ? "authority" : "projection", "@borg/project-brief", "Original project brief", projectBrief, Boolean(authoritativeBrief));

  add("authority", "@borg/project-plan", "Durable approved project constraints", bounded(JSON.stringify({
    revision: plan.revision,
    siteGoal: plan.siteGoal,
    audience: plan.audience,
    pages: plan.pages,
    features: plan.features,
    visualDirection: plan.visualDirection,
    acceptanceCriteria: plan.acceptanceCriteria,
    backendRequired: plan.backendRequired,
  }, null, 2), 4_500), true);

  add("authority", "@borg/style-system", "Durable global style system", bounded(JSON.stringify(plan.styles, null, 2), 5_000), true);

  if (input.profileKind === "slice") {
    add("authority", "@borg/current-work", "Core-selected frontend slice", bounded(JSON.stringify({
      index: sliceIndex,
      total: plan.slices.length,
      slice,
      status: state?.status ?? "working",
      feedback: state?.feedback ?? [],
    }, null, 2), 4_500), true);
  } else if (scope?.type === "page") {
    add("authority", "@borg/current-work", "Selected page workspace boundary", bounded(JSON.stringify(
      plan.sitemap.find((item) => item.id === scope.id) ?? registry.pages[0] ?? { id: scope.id },
      null,
      2,
    ), 6_000), true);
  } else if (scope?.type === "component") {
    add("authority", "@borg/current-work", "Selected component workspace boundary", bounded(JSON.stringify(
      plan.components.find((item) => item.id === scope.id) ?? registry.components[0] ?? { id: scope.id },
      null,
      2,
    ), 6_000), true);
  } else {
    add("authority", "@borg/current-work", "Global style workspace boundary", bounded(JSON.stringify({
      scope: "global styles",
      allowed: ["color", "typography", "spacing", "radii", "shadows", "layout rhythm", "responsive styling", "motion", "accessibility styling"],
      preserve: ["routes", "page responsibilities", "component responsibilities", "product behavior", "data contracts"],
    }, null, 2), 4_000), true);
  }

  const design = readPersistedDesignBrief(input.root);
  if (design) add("projection", ".localcode/build/design-brief.md", "Persisted approved design direction", bounded(JSON.stringify(design, null, 2), 6_000));

  add("registry", ".localcode/build/pages.json", input.profileKind === "styles" ? "Project page inventory" : "Pages relevant to this context", bounded(JSON.stringify(registry.pages, null, 2), 4_500), true);
  add("registry", ".localcode/build/components.json", input.profileKind === "styles" ? "Project component inventory" : "Components relevant to this context", bounded(JSON.stringify(registry.components, null, 2), 5_500), true);

  const decisions = optionalProjection(input.root, "decisions.md", 3_500, true);
  if (decisions) add("projection", ".localcode/build/decisions.md", "Recent durable project decisions", decisions);
  const handoff = optionalProjection(input.root, "handoff.md", 3_500, true);
  if (handoff) add("projection", ".localcode/build/handoff.md", "Latest checkpoint handoff", handoff);
  if ((input.stage ?? "planning") !== "planning") {
    const currentPlan = optionalProjection(input.root, "current-plan.md", 4_500, false);
    if (currentPlan) add("projection", ".localcode/build/current-plan.md", "Approved mini-plan execution notes", currentPlan);
  }

  const explicit = [...new Set(registry.explicitFiles)].map((path) => {
    try { return validateProjectSource(input.root, path); } catch { return null; }
  }).filter((path): path is string => Boolean(path));

  const hints = normalizeHints(input.root, input.sourceHints);
  const sourceCandidates = [
    ...explicit.map((path) => ({ path, reason: "Registered source for selected project entities" })),
    ...hints,
  ];
  for (const path of entrypoints) {
    if (sourceCandidates.length) break;
    if (existsSync(join(input.root, path))) sourceCandidates.push({ path, reason: "Frontend entrypoint fallback; no registered or indexed source matched" });
  }

  for (const candidate of sourceCandidates.filter((item, index, values) => values.findIndex((other) => other.path === item.path) === index).slice(0, 16)) {
    const safe = validateProjectSource(input.root, candidate.path);
    const absolute = join(input.root, safe);
    if (!existsSync(absolute) || !lstatSync(absolute).isFile()) continue;
    add("source", safe, candidate.reason, bounded(readFileSync(absolute, "utf8"), 10_000));
  }

  const text = sections.join("\n");
  const pack = {
    version: 1 as const,
    profile,
    authority,
    sliceId: profileId,
    text,
    manifest,
    characters,
    budgetCharacters,
    fingerprint: hash(JSON.stringify({
      profile,
      authority,
      manifest: manifest.map(({ path, sha256, required }) => ({ path, sha256, required })),
      textSha256: hash(text),
    })),
  };
  return ContextPackSchema.parse(pack);
}

export function compileFrontendContext(input: ContextInput): CompiledContext {
  return compileContextPack({
    ...input,
    profileKind: input.scope?.type ?? "slice",
    sliceIndex: input.sliceIndex,
    scope: input.scope ?? null,
  });
}

export function compileFocusedFrontendContext(input: FocusedContextInput): CompiledContext {
  return compileContextPack({
    ...input,
    profileKind: input.scope.type,
    sliceIndex: null,
    scope: input.scope,
  });
}

export function compileStyleFrontendContext(input: StyleContextInput): CompiledContext {
  return compileContextPack({
    ...input,
    profileKind: "styles",
    sliceIndex: null,
    scope: { type: "styles", id: "global" },
  });
}
