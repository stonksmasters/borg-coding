"use client";

import { useMemo, useState } from "react";
import { ArrowRight, Layers3, Map as MapIcon, Palette, Route, Sparkles, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DocsPanel, type BuildDoc } from "@/components/workspace/docs-panel";

export type SitemapPage = {
  id: string;
  name: string;
  route: string;
  purpose: string;
  sections: string[];
  componentIds: string[];
  acceptanceCriteria: string[];
};

export type UserFlow = {
  id: string;
  name: string;
  purpose: string;
  steps: string[];
};

export type PlannedComponent = {
  id: string;
  name: string;
  kind: "layout" | "section" | "ui" | "feature";
  purpose: string;
  usedBy: string[];
  variants: string[];
  acceptanceCriteria: string[];
};

export type StyleSystem = {
  direction: string;
  colors: string[];
  typography: string[];
  spacing: string[];
  radii: string[];
  shadows: string[];
  layoutPrinciples: string[];
  motion: string[];
  responsive: string[];
  accessibility: string[];
  avoid: string[];
};

export type PlannedSlice = {
  id: string;
  title: string;
  outcome: string;
  scope: string[];
  acceptanceCriteria: string[];
};

export type ProjectBlueprint = {
  version?: number;
  revision?: number;
  status?: "proposed" | "approved" | "frontend_complete";
  siteGoal?: string;
  audience?: string;
  sitemap?: SitemapPage[];
  flows?: UserFlow[];
  components?: PlannedComponent[];
  styles?: StyleSystem;
  slices?: PlannedSlice[];
};

export type BlueprintView = "sitemap" | "styles" | "components" | "roadmap";

function structuredPlan(docs: BuildDoc[]): ProjectBlueprint | null {
  const plan = docs.find((doc) => /\/plan\.md$/.test(doc.path));
  const match = plan?.content.match(/<borg-project-plan>([\s\S]*?)<\/borg-project-plan>/i);
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]) as ProjectBlueprint;
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function Pill({ children }: { children: React.ReactNode }) {
  return <span className="rounded-md border border-white/8 bg-white/[0.035] px-2 py-1 text-[10px] text-slate-400">{children}</span>;
}

function Empty({ label }: { label: string }) {
  return <div className="grid h-full flex-1 place-items-center p-8 text-center text-sm text-slate-500">{label}</div>;
}

const blueprintStages: Array<{ key: BlueprintView; number: number; label: string; detail: string }> = [
  { key: "sitemap", number: 1, label: "Product map", detail: "Routes, sections, journeys" },
  { key: "styles", number: 2, label: "Design system", detail: "Shared visual primitives" },
  { key: "components", number: 3, label: "Components", detail: "Reusable build architecture" },
  { key: "roadmap", number: 4, label: "Build roadmap", detail: "Foundation-first slices" },
];

function BlueprintStageRail({ view }: { view: BlueprintView }) {
  return <div className="mb-6 grid gap-2 lg:grid-cols-4">
    {blueprintStages.map((stage) => {
      const active = stage.key === view;
      return <div key={stage.key} className={`rounded-lg border px-3 py-2.5 ${active ? "border-[#a7ff4f]/25 bg-[#a7ff4f]/[0.055]" : "border-white/8 bg-white/[0.02]"}`}>
        <div className="flex items-center gap-2">
          <span className={`grid size-5 place-items-center rounded-full text-[10px] font-semibold ${active ? "bg-[#a7ff4f] text-[#071007]" : "bg-white/7 text-slate-500"}`}>{stage.number}</span>
          <span className={`text-xs font-medium ${active ? "text-[#d9ffb5]" : "text-slate-400"}`}>{stage.label}</span>
        </div>
        <p className="mt-1.5 pl-7 text-[10px] text-slate-600">{stage.detail}</p>
      </div>;
    })}
  </div>;
}

function BlueprintFeedback({
  title,
  detail,
  placeholder,
  busy,
  onFeedback,
}: {
  title: string;
  detail: string;
  placeholder: string;
  busy: boolean;
  onFeedback?: (feedback: string) => Promise<void> | void;
}) {
  const [feedback, setFeedback] = useState("");
  if (!onFeedback) return null;
  return <section className="mt-5 rounded-xl border border-amber-300/15 bg-amber-300/[0.035] p-4">
    <div className="flex items-center gap-2"><Sparkles className="size-4 text-amber-200" /><h3 className="text-sm font-medium text-amber-100">{title}</h3></div>
    <p className="mt-1 text-xs leading-5 text-slate-500">{detail}</p>
    <textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} disabled={busy} rows={4} placeholder={placeholder} className="mt-3 w-full resize-y rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm leading-6 text-slate-100 outline-none placeholder:text-slate-600 focus:border-amber-200/35 disabled:opacity-50" />
    <Button type="button" disabled={busy || !feedback.trim()} onClick={() => {
      const value = feedback.trim();
      if (!value) return;
      void Promise.resolve(onFeedback(value)).then(() => setFeedback(""));
    }} className="mt-3 bg-amber-200 text-[#171005]">{busy ? "Replanning…" : "Revise blueprint"}</Button>
  </section>;
}

function SitemapView({
  pages,
  flows,
  status,
  busy,
  onOpenPage,
  onRevisionFeedback,
}: {
  pages: SitemapPage[];
  flows: UserFlow[];
  status?: ProjectBlueprint["status"];
  busy: boolean;
  onOpenPage?(page: SitemapPage): void;
  onRevisionFeedback?(feedback: string): Promise<void> | void;
}) {
  if (!pages.length) return <Empty label="The product map will appear after Blueprint Stage 1 completes." />;
  const names = new Map(pages.map((page) => [page.id, page.name]));
  return <div className="h-full overflow-y-auto p-5 sm:p-7">
    <BlueprintStageRail view="sitemap" />
    <div className="mb-6 flex items-start gap-3">
      <div className="rounded-lg border border-[#a7ff4f]/15 bg-[#a7ff4f]/5 p-2"><MapIcon className="size-4 text-[#a7ff4f]" /></div>
      <div>
        <h2 className="text-base font-semibold text-white">Product map &amp; sitemap</h2>
        <p className="mt-1 text-xs leading-5 text-slate-500">The durable information architecture BORG uses to understand the whole product before component implementation begins.</p>
      </div>
    </div>
    <div className="space-y-3">{pages.map((page, index) => <section key={page.id} className="rounded-xl border border-white/8 bg-white/[0.025] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><p className="text-[10px] uppercase tracking-[0.14em] text-slate-600">Page {index + 1} · {page.id}</p><h3 className="mt-1 text-sm font-semibold text-slate-100">{page.name}</h3></div>
        <span className="flex items-center gap-1.5 rounded-md border border-white/10 bg-black/20 px-2 py-1 font-mono text-[10px] text-[#d9ffb5]"><Route className="size-3" />{page.route}</span>
      </div>
      <p className="mt-3 text-xs leading-5 text-slate-400">{page.purpose}</p>
      <div className="mt-4"><p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-slate-600">Ordered sections</p><div className="flex flex-wrap gap-1.5">{page.sections.map((section) => <Pill key={section}>{section}</Pill>)}</div></div>
      {page.componentIds.length > 0 && <div className="mt-4"><p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-slate-600">Component ownership</p><div className="flex flex-wrap gap-1.5">{page.componentIds.map((id) => <Pill key={id}>{id}</Pill>)}</div></div>}
      {onOpenPage && status !== "proposed" && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onOpenPage(page)} className="mt-4 border-white/10 bg-transparent text-slate-300">Open page workspace</Button>}
    </section>)}</div>

    <section className="mt-5 rounded-xl border border-white/8 bg-white/[0.025] p-4">
      <div className="flex items-center gap-2"><Workflow className="size-4 text-[#a7ff4f]" /><h3 className="text-sm font-medium text-slate-100">User journeys</h3></div>
      <p className="mt-1 text-xs leading-5 text-slate-500">Journeys connect the sitemap into real product behavior and help prevent isolated-page planning.</p>
      <div className="mt-4 space-y-3">{flows.length ? flows.map((flow) => <div key={flow.id} className="rounded-lg border border-white/7 bg-black/15 p-3">
        <p className="text-xs font-medium text-slate-200">{flow.name}</p>
        <p className="mt-1 text-[11px] leading-5 text-slate-500">{flow.purpose}</p>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">{flow.steps.map((step, index) => <div key={`${flow.id}:${step}:${index}`} className="flex items-center gap-1.5"><Pill>{names.get(step) ?? step}</Pill>{index < flow.steps.length - 1 && <ArrowRight className="size-3 text-slate-700" />}</div>)}</div>
      </div>) : <p className="text-xs text-slate-600">No multi-page journey is required for this product.</p>}</div>
    </section>

    <BlueprintFeedback
      title="Revise the product map before approval"
      detail="This rejects the current proposal and starts another outer blueprint planning pass. No source mutation is authorized."
      placeholder="Example: Remove Pricing, add Saved Items and Creator Profile, and make checkout a three-step journey."
      busy={busy}
      onFeedback={status === "proposed" ? onRevisionFeedback : undefined}
    />
  </div>;
}

function ComponentsView({
  components,
  pages,
  status,
  busy,
  onOpenComponent,
  onRevisionFeedback,
}: {
  components: PlannedComponent[];
  pages: SitemapPage[];
  status?: ProjectBlueprint["status"];
  busy: boolean;
  onOpenComponent?(component: PlannedComponent): void;
  onRevisionFeedback?(feedback: string): Promise<void> | void;
}) {
  const pageNames = new Map(pages.map((page) => [page.id, page.name]));
  if (!components.length) return <Empty label="The component architecture will appear after Blueprint Stage 3 completes." />;
  return <div className="h-full overflow-y-auto p-5 sm:p-7">
    <BlueprintStageRail view="components" />
    <div className="mb-6 flex items-start gap-3">
      <div className="rounded-lg border border-[#a7ff4f]/15 bg-[#a7ff4f]/5 p-2"><Layers3 className="size-4 text-[#a7ff4f]" /></div>
      <div><h2 className="text-base font-semibold text-white">Component architecture</h2><p className="mt-1 text-xs leading-5 text-slate-500">Reusable build units derived from the approved product map and global design system—not invented independently during implementation.</p></div>
    </div>
    <div className="grid gap-3 xl:grid-cols-2">{components.map((component) => <section key={component.id} className="rounded-xl border border-white/8 bg-white/[0.025] p-4">
      <div className="flex items-start justify-between gap-3"><div><p className="text-[10px] uppercase tracking-[0.14em] text-slate-600">{component.id}</p><h3 className="mt-1 text-sm font-semibold text-slate-100">{component.name}</h3></div><Pill>{component.kind}</Pill></div>
      <p className="mt-3 text-xs leading-5 text-slate-400">{component.purpose}</p>
      <div className="mt-4"><p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-slate-600">Used by</p><div className="flex flex-wrap gap-1.5">{component.usedBy.length ? component.usedBy.map((id) => <Pill key={id}>{pageNames.get(id) ?? id}</Pill>) : <Pill>Global/shared</Pill>}</div></div>
      {component.variants.length > 0 && <div className="mt-4"><p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-slate-600">Variants</p><div className="flex flex-wrap gap-1.5">{component.variants.map((variant) => <Pill key={variant}>{variant}</Pill>)}</div></div>}
      {onOpenComponent && status !== "proposed" && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onOpenComponent(component)} className="mt-4 border-white/10 bg-transparent text-slate-300">Open component workspace</Button>}
    </section>)}</div>
    <BlueprintFeedback
      title="Revise component architecture before approval"
      detail="Use this when component ownership, reuse boundaries, or variants are wrong. The sitemap/design system remain explicit constraints unless your feedback says they must change."
      placeholder="Example: ProductCard should have compact and editorial variants, and Filters should be one shared feature component across Discover and Search."
      busy={busy}
      onFeedback={status === "proposed" ? onRevisionFeedback : undefined}
    />
  </div>;
}

function StyleGroup({ title, values }: { title: string; values: string[] }) {
  return <section className="rounded-xl border border-white/8 bg-white/[0.025] p-4"><h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">{title}</h3><div className="mt-3 space-y-2">{values.length ? values.map((value, index) => <p key={index} className="text-xs leading-5 text-slate-300">• {value}</p>) : <p className="text-xs text-slate-600">Not specified.</p>}</div></section>;
}

function StylesView({
  styles,
  status,
  busy,
  onFeedback,
  onRevisionFeedback,
}: {
  styles: StyleSystem | null;
  status?: ProjectBlueprint["status"];
  busy: boolean;
  onFeedback?(feedback: string): Promise<void> | void;
  onRevisionFeedback?(feedback: string): Promise<void> | void;
}) {
  const [feedback, setFeedback] = useState("");
  if (!styles) return <Empty label="The global design system will appear after Blueprint Stage 2 completes." />;
  return <div className="h-full overflow-y-auto p-5 sm:p-7">
    <BlueprintStageRail view="styles" />
    <div className="mb-6 flex items-start gap-3">
      <div className="rounded-lg border border-[#a7ff4f]/15 bg-[#a7ff4f]/5 p-2"><Palette className="size-4 text-[#a7ff4f]" /></div>
      <div><h2 className="text-base font-semibold text-white">Global design system</h2><p className="mt-1 text-xs leading-5 text-slate-500">Implementation-grade site-wide primitives established before product component architecture.</p></div>
    </div>
    <section className="mb-4 rounded-xl border border-[#a7ff4f]/15 bg-[#a7ff4f]/[0.035] p-4"><p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#a7ff4f]">Direction</p><p className="mt-2 text-sm leading-6 text-slate-200">{styles.direction}</p></section>
    <div className="grid gap-3 xl:grid-cols-2">
      <StyleGroup title="Colors / semantic tokens" values={styles.colors} />
      <StyleGroup title="Typography roles / scale" values={styles.typography} />
      <StyleGroup title="Spacing / rhythm" values={styles.spacing} />
      <StyleGroup title="Radii" values={styles.radii} />
      <StyleGroup title="Shadows / elevation" values={styles.shadows} />
      <StyleGroup title="Layout principles" values={styles.layoutPrinciples} />
      <StyleGroup title="Motion" values={styles.motion} />
      <StyleGroup title="Responsive recomposition" values={styles.responsive} />
      <StyleGroup title="Accessibility foundation" values={styles.accessibility} />
      <StyleGroup title="Avoid" values={styles.avoid} />
    </div>

    {status === "proposed" ? <BlueprintFeedback
      title="Revise the design system before approval"
      detail="This sends your visual feedback back through the outer blueprint planner. Components and slices will be regenerated from the revised design foundation."
      placeholder="Example: Make this darker and more editorial, reduce radius, increase type contrast, use warm neutrals, and define a more dramatic section-spacing scale."
      busy={busy}
      onFeedback={onRevisionFeedback}
    /> : onFeedback && <section className="mt-5 rounded-xl border border-white/10 bg-black/20 p-4">
      <div className="flex items-center gap-2"><Sparkles className="size-4 text-[#a7ff4f]" /><h3 className="text-sm font-medium text-slate-100">Work on overall styling</h3></div>
      <p className="mt-1 text-xs leading-5 text-slate-500">This opens the dedicated Styles workspace. BORG preserves the approved sitemap/component responsibilities and mutates shared visual primitives first.</p>
      <textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} disabled={busy} rows={4} placeholder="Example: Make the whole site more editorial and premium." className="mt-3 w-full resize-y rounded-lg border border-white/10 bg-white/[0.035] px-3 py-2 text-sm leading-6 text-slate-100 outline-none placeholder:text-slate-600 focus:border-[#a7ff4f]/40 disabled:opacity-50" />
      <Button type="button" disabled={busy || !feedback.trim()} onClick={() => {
        const value = feedback.trim();
        if (!value) return;
        void Promise.resolve(onFeedback(value)).then(() => setFeedback(""));
      }} className="mt-3 bg-[#a7ff4f] text-[#071007]">{busy ? "Starting…" : "Open Styles workspace"}</Button>
    </section>}
  </div>;
}

function RoadmapView({
  slices,
  status,
  busy,
  onRevisionFeedback,
}: {
  slices: PlannedSlice[];
  status?: ProjectBlueprint["status"];
  busy: boolean;
  onRevisionFeedback?(feedback: string): Promise<void> | void;
}) {
  if (!slices.length) return <Empty label="The implementation roadmap will appear after Blueprint Stage 4 completes." />;
  return <div className="h-full overflow-y-auto p-5 sm:p-7">
    <BlueprintStageRail view="roadmap" />
    <div className="mb-6">
      <h2 className="text-base font-semibold text-white">Foundation-first build roadmap</h2>
      <p className="mt-1 text-xs leading-5 text-slate-500">The global visual foundation is deliberately implemented before product-specific component/page slices.</p>
    </div>
    <div className="space-y-3">{slices.map((slice, index) => <section key={slice.id} className={`rounded-xl border p-4 ${index === 0 ? "border-[#a7ff4f]/20 bg-[#a7ff4f]/[0.035]" : "border-white/8 bg-white/[0.025]"}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><p className="text-[10px] uppercase tracking-[0.14em] text-slate-600">Slice {index + 1} · {slice.id}</p><h3 className="mt-1 text-sm font-semibold text-slate-100">{slice.title}</h3></div>
        {index === 0 && <Pill>foundation first</Pill>}
      </div>
      <p className="mt-3 text-xs leading-5 text-slate-400">{slice.outcome}</p>
      <div className="mt-4"><p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-slate-600">Scope</p><div className="flex flex-wrap gap-1.5">{slice.scope.map((item) => <Pill key={item}>{item}</Pill>)}</div></div>
      <div className="mt-4"><p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-slate-600">Acceptance</p><div className="space-y-1">{slice.acceptanceCriteria.map((item) => <p key={item} className="text-[11px] leading-5 text-slate-500">• {item}</p>)}</div></div>
    </section>)}</div>
    <BlueprintFeedback
      title="Revise the build roadmap before approval"
      detail="The roadmap can change while the blueprint is proposed. Approval freezes this ordered slice contract."
      placeholder="Example: Split Product Detail into its own slice and move responsive cross-page polish into the final review slice."
      busy={busy}
      onFeedback={status === "proposed" ? onRevisionFeedback : undefined}
    />
  </div>;
}

export function StructurePanel({
  view,
  blueprint,
  docs = [],
  styleBusy = false,
  focusBusy = false,
  revisionBusy = false,
  onStyleFeedback,
  onRevisionFeedback,
  onOpenPage,
  onOpenComponent,
}: {
  view: BlueprintView;
  blueprint?: ProjectBlueprint | null;
  docs?: BuildDoc[];
  styleBusy?: boolean;
  focusBusy?: boolean;
  revisionBusy?: boolean;
  onStyleFeedback?(feedback: string): Promise<void> | void;
  onRevisionFeedback?(feedback: string): Promise<void> | void;
  onOpenPage?(page: SitemapPage): void;
  onOpenComponent?(component: PlannedComponent): void;
}) {
  const legacy = useMemo(() => structuredPlan(docs), [docs]);
  const plan = blueprint ?? legacy;
  if (!plan) {
    const fallback = docs.filter((doc) => view === "sitemap" ? /site.?map|page/i.test(`${doc.path} ${doc.title}`) : view === "components" ? /component/i.test(`${doc.path} ${doc.title}`) : view === "styles" ? /style|design/i.test(`${doc.path} ${doc.title}`) : /plan|slice|roadmap/i.test(`${doc.path} ${doc.title}`));
    return fallback.length ? <DocsPanel docs={fallback} /> : <Empty label="The project blueprint has not been generated yet." />;
  }
  const focusedEditingReady = plan.status === "approved" || plan.status === "frontend_complete";
  const busy = focusBusy || styleBusy || revisionBusy;
  if (view === "sitemap") return <SitemapView pages={plan.sitemap ?? []} flows={plan.flows ?? []} status={plan.status} busy={busy} onOpenPage={focusedEditingReady ? onOpenPage : undefined} onRevisionFeedback={onRevisionFeedback} />;
  if (view === "components") return <ComponentsView components={plan.components ?? []} pages={plan.sitemap ?? []} status={plan.status} busy={busy} onOpenComponent={focusedEditingReady ? onOpenComponent : undefined} onRevisionFeedback={onRevisionFeedback} />;
  if (view === "roadmap") return <RoadmapView slices={plan.slices ?? []} status={plan.status} busy={busy} onRevisionFeedback={onRevisionFeedback} />;
  return <StylesView styles={plan.styles ?? null} status={plan.status} busy={busy} onFeedback={focusedEditingReady ? onStyleFeedback : undefined} onRevisionFeedback={onRevisionFeedback} />;
}
