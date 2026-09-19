"use client";

import { useMemo, useState } from "react";
import { Layers3, Map as MapIcon, Palette, Route, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DocsPanel, type BuildDoc } from "@/components/workspace/docs-panel";

type SitemapPage = {
  id: string;
  name: string;
  route: string;
  purpose: string;
  sections: string[];
  componentIds: string[];
  acceptanceCriteria: string[];
};

type PlannedComponent = {
  id: string;
  name: string;
  kind: "layout" | "section" | "ui" | "feature";
  purpose: string;
  usedBy: string[];
  variants: string[];
  acceptanceCriteria: string[];
};

type StyleSystem = {
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

type StructuredPlan = {
  status?: "proposed" | "approved" | "frontend_complete";
  sitemap?: SitemapPage[];
  components?: PlannedComponent[];
  styles?: StyleSystem;
};

function structuredPlan(docs: BuildDoc[]): StructuredPlan | null {
  const plan = docs.find((doc) => /\/plan\.md$/.test(doc.path));
  const match = plan?.content.match(/<borg-project-plan>([\s\S]*?)<\/borg-project-plan>/i);
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]) as StructuredPlan;
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

function SitemapView({ pages, busy, onOpenPage }: { pages: SitemapPage[]; busy: boolean; onOpenPage?(page: SitemapPage): void }) {
  if (!pages.length) return <Empty label="The sitemap will appear after the website plan is generated." />;
  return <div className="h-full overflow-y-auto p-5 sm:p-7">
    <div className="mb-6 flex items-start gap-3">
      <div className="rounded-lg border border-[#a7ff4f]/15 bg-[#a7ff4f]/5 p-2"><MapIcon className="size-4 text-[#a7ff4f]" /></div>
      <div><h2 className="text-base font-semibold text-white">Website sitemap</h2><p className="mt-1 text-xs leading-5 text-slate-500">The complete page and route contract BORG will build. These IDs are durable so pages can become isolated workspaces later.</p></div>
    </div>
    <div className="space-y-3">{pages.map((page, index) => <section key={page.id} className="rounded-xl border border-white/8 bg-white/[0.025] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><p className="text-[10px] uppercase tracking-[0.14em] text-slate-600">Page {index + 1} · {page.id}</p><h3 className="mt-1 text-sm font-semibold text-slate-100">{page.name}</h3></div>
        <span className="flex items-center gap-1.5 rounded-md border border-white/10 bg-black/20 px-2 py-1 font-mono text-[10px] text-[#d9ffb5]"><Route className="size-3" />{page.route}</span>
      </div>
      <p className="mt-3 text-xs leading-5 text-slate-400">{page.purpose}</p>
      <div className="mt-4"><p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-slate-600">Sections</p><div className="flex flex-wrap gap-1.5">{page.sections.map((section) => <Pill key={section}>{section}</Pill>)}</div></div>
      <div className="mt-4"><p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-slate-600">Planned components</p><div className="flex flex-wrap gap-1.5">{page.componentIds.length ? page.componentIds.map((id) => <Pill key={id}>{id}</Pill>) : <span className="text-xs text-slate-600">No component IDs assigned yet.</span>}</div></div>
      {onOpenPage && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onOpenPage(page)} className="mt-4 border-white/10 bg-transparent text-slate-300">Open page workspace</Button>}
    </section>)}</div>
  </div>;
}

function ComponentsView({ components, pages, busy, onOpenComponent }: { components: PlannedComponent[]; pages: SitemapPage[]; busy: boolean; onOpenComponent?(component: PlannedComponent): void }) {
  const pageNames = new Map(pages.map((page) => [page.id, page.name]));
  if (!components.length) return <Empty label="The component inventory will appear after the website plan is generated." />;
  return <div className="h-full overflow-y-auto p-5 sm:p-7">
    <div className="mb-6 flex items-start gap-3">
      <div className="rounded-lg border border-[#a7ff4f]/15 bg-[#a7ff4f]/5 p-2"><Layers3 className="size-4 text-[#a7ff4f]" /></div>
      <div><h2 className="text-base font-semibold text-white">Component inventory</h2><p className="mt-1 text-xs leading-5 text-slate-500">Reusable build units planned before implementation. Later, each stable component ID can open its own focused workspace.</p></div>
    </div>
    <div className="grid gap-3 xl:grid-cols-2">{components.map((component) => <section key={component.id} className="rounded-xl border border-white/8 bg-white/[0.025] p-4">
      <div className="flex items-start justify-between gap-3"><div><p className="text-[10px] uppercase tracking-[0.14em] text-slate-600">{component.id}</p><h3 className="mt-1 text-sm font-semibold text-slate-100">{component.name}</h3></div><Pill>{component.kind}</Pill></div>
      <p className="mt-3 text-xs leading-5 text-slate-400">{component.purpose}</p>
      <div className="mt-4"><p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-slate-600">Used by</p><div className="flex flex-wrap gap-1.5">{component.usedBy.length ? component.usedBy.map((id) => <Pill key={id}>{pageNames.get(id) ?? id}</Pill>) : <Pill>Global/shared</Pill>}</div></div>
      {component.variants.length > 0 && <div className="mt-4"><p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-slate-600">Variants</p><div className="flex flex-wrap gap-1.5">{component.variants.map((variant) => <Pill key={variant}>{variant}</Pill>)}</div></div>}
      {onOpenComponent && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onOpenComponent(component)} className="mt-4 border-white/10 bg-transparent text-slate-300">Open component workspace</Button>}
    </section>)}</div>
  </div>;
}

function StyleGroup({ title, values }: { title: string; values: string[] }) {
  return <section className="rounded-xl border border-white/8 bg-white/[0.025] p-4"><h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">{title}</h3><div className="mt-3 space-y-2">{values.length ? values.map((value, index) => <p key={index} className="text-xs leading-5 text-slate-300">• {value}</p>) : <p className="text-xs text-slate-600">Not specified.</p>}</div></section>;
}

function StylesView({ styles, busy, onFeedback }: { styles: StyleSystem | null; busy: boolean; onFeedback?(feedback: string): Promise<void> | void }) {
  const [feedback, setFeedback] = useState("");
  if (!styles) return <Empty label="The global style system will appear after the website plan is generated." />;
  return <div className="h-full overflow-y-auto p-5 sm:p-7">
    <div className="mb-6 flex items-start gap-3">
      <div className="rounded-lg border border-[#a7ff4f]/15 bg-[#a7ff4f]/5 p-2"><Palette className="size-4 text-[#a7ff4f]" /></div>
      <div><h2 className="text-base font-semibold text-white">Global style system</h2><p className="mt-1 text-xs leading-5 text-slate-500">Site-wide visual rules, independent of any one page or component. Style work should change shared primitives first and preserve content, routes, and behavior.</p></div>
    </div>
    <section className="mb-4 rounded-xl border border-[#a7ff4f]/15 bg-[#a7ff4f]/[0.035] p-4"><p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#a7ff4f]">Direction</p><p className="mt-2 text-sm leading-6 text-slate-200">{styles.direction}</p></section>
    <div className="grid gap-3 xl:grid-cols-2">
      <StyleGroup title="Colors" values={styles.colors} />
      <StyleGroup title="Typography" values={styles.typography} />
      <StyleGroup title="Spacing" values={styles.spacing} />
      <StyleGroup title="Radii" values={styles.radii} />
      <StyleGroup title="Shadows" values={styles.shadows} />
      <StyleGroup title="Layout principles" values={styles.layoutPrinciples} />
      <StyleGroup title="Motion" values={styles.motion} />
      <StyleGroup title="Responsive" values={styles.responsive} />
      <StyleGroup title="Accessibility" values={styles.accessibility} />
      <StyleGroup title="Avoid" values={styles.avoid} />
    </div>
    {onFeedback && <section className="mt-5 rounded-xl border border-white/10 bg-black/20 p-4">
      <div className="flex items-center gap-2"><Sparkles className="size-4 text-[#a7ff4f]" /><h3 className="text-sm font-medium text-slate-100">Work on overall styling</h3></div>
      <p className="mt-1 text-xs leading-5 text-slate-500">This opens the dedicated Styles workspace. BORG is instructed to preserve sitemap, component responsibilities, content, and behavior while changing the shared visual system.</p>
      <textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} disabled={busy} rows={4} placeholder="Example: Make the whole site feel more editorial and premium. Reduce rounded cards, increase type contrast, use warmer neutrals, and make section spacing more dramatic." className="mt-3 w-full resize-y rounded-lg border border-white/10 bg-white/[0.035] px-3 py-2 text-sm leading-6 text-slate-100 outline-none placeholder:text-slate-600 focus:border-[#a7ff4f]/40 disabled:opacity-50" />
      <Button type="button" disabled={busy || !feedback.trim()} onClick={() => { const value = feedback.trim(); if (!value) return; void Promise.resolve(onFeedback(value)).then(() => setFeedback("")); }} className="mt-3 bg-[#a7ff4f] text-[#071007]">{busy ? "Starting…" : "Open Styles workspace"}</Button>
    </section>}
  </div>;
}

export function StructurePanel({ view, docs, styleBusy = false, focusBusy = false, onStyleFeedback, onOpenPage, onOpenComponent }: { view: "sitemap" | "components" | "styles"; docs: BuildDoc[]; styleBusy?: boolean; focusBusy?: boolean; onStyleFeedback?(feedback: string): Promise<void> | void; onOpenPage?(page: SitemapPage): void; onOpenComponent?(component: PlannedComponent): void }) {
  const plan = useMemo(() => structuredPlan(docs), [docs]);
  if (!plan) {
    const fallback = docs.filter((doc) => view === "sitemap" ? /site.?map|page/i.test(`${doc.path} ${doc.title}`) : view === "components" ? /component/i.test(`${doc.path} ${doc.title}`) : /style|design/i.test(`${doc.path} ${doc.title}`));
    return <DocsPanel docs={fallback} />;
  }
  const focusedEditingReady = plan.status === "approved" || plan.status === "frontend_complete";
  if (view === "sitemap") return <SitemapView pages={plan.sitemap ?? []} busy={focusBusy || !focusedEditingReady} onOpenPage={focusedEditingReady ? onOpenPage : undefined} />;
  if (view === "components") return <ComponentsView components={plan.components ?? []} pages={plan.sitemap ?? []} busy={focusBusy || !focusedEditingReady} onOpenComponent={focusedEditingReady ? onOpenComponent : undefined} />;
  return <StylesView styles={plan.styles ?? null} busy={styleBusy || !focusedEditingReady} onFeedback={focusedEditingReady ? onStyleFeedback : undefined} />;
}
