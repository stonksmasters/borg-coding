"use client";

import { Palette, RotateCcw, Sparkles } from "lucide-react";

export interface DesignBriefView {
  taskId: string;
  createdAt: string;
  audience: string;
  primaryPromise: string;
  brandCharacter: string[];
  visualDirection: string;
  typography: { display: string; body: string; hierarchy: string };
  palette: { role: string; direction: string }[];
  sections: { purpose: string; composition: string; visualWeight: "quiet" | "balanced" | "high-impact" }[];
  motion: string[];
  mobileStrategy: string[];
  contentVoice: string[];
  avoid: string[];
  qualityBar: string[];
}

export interface DesignReviewView {
  taskId: string;
  status: "pass" | "repair" | "inconclusive" | "unavailable" | "failed";
  summary: string;
  dimensions: { dimension: string; verdict: "pass" | "repair"; evidence: string; recommendation: string }[];
  findings: { severity: string; category: string; title: string; description: string; evidence?: string; remediation?: string }[];
  provider: string;
  model: string;
  reviewedAt: string;
}

function weightLabel(value: string) {
  return value === "high-impact" ? "High impact" : value === "quiet" ? "Quiet" : "Balanced";
}

export function DesignPanel({
  brief,
  review,
  refinementCount,
  maxRefinements,
}: {
  brief: DesignBriefView | null;
  review: DesignReviewView | null;
  refinementCount: number;
  maxRefinements: number;
}) {
  if (!brief) {
    return <div className="grid min-h-0 flex-1 place-items-center overflow-y-auto overscroll-contain p-8 text-center">
      <div>
        <Palette className="mx-auto mb-3 size-6 text-slate-600" />
        <p className="text-sm font-medium text-slate-300">No design direction for this task</p>
        <p className="mt-1 max-w-sm text-xs leading-5 text-slate-500">Greenfield websites and visual redesigns get a persisted Design Director brief before implementation begins.</p>
      </div>
    </div>;
  }

  return <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5" data-workspace-scroll="design">
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="border-b border-white/8 pb-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-[#a7ff4f]">
            <Sparkles className="size-4" />
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em]">Design direction</span>
          </div>
          {refinementCount > 0 && <div className="flex items-center gap-1.5 rounded-full border border-amber-200/10 bg-amber-200/5 px-2.5 py-1 text-[10px] text-amber-100">
            <RotateCcw className="size-3" /> Refinement {refinementCount}/{maxRefinements}
          </div>}
        </div>
        <h2 className="mt-3 text-xl font-semibold tracking-tight text-white">{brief.visualDirection}</h2>
        <p className="mt-2 text-sm leading-6 text-slate-400">{brief.primaryPromise}</p>
      </header>

      <section className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-white/8 bg-white/[0.025] p-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Audience</p>
          <p className="mt-2 text-sm leading-6 text-slate-300">{brief.audience}</p>
        </div>
        <div className="rounded-lg border border-white/8 bg-white/[0.025] p-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Brand character</p>
          <div className="mt-2 flex flex-wrap gap-1.5">{brief.brandCharacter.map((item) => <span key={item} className="rounded-full border border-white/8 px-2 py-1 text-[11px] text-slate-300">{item}</span>)}</div>
        </div>
      </section>

      <section>
        <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">Typography</h3>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          {[
            ["Display", brief.typography.display],
            ["Body", brief.typography.body],
            ["Hierarchy", brief.typography.hierarchy],
          ].map(([label, value]) => <div key={label} className="border-l border-white/10 pl-3"><p className="text-[10px] uppercase tracking-wider text-slate-600">{label}</p><p className="mt-1 text-xs leading-5 text-slate-300">{value}</p></div>)}
        </div>
      </section>

      <section>
        <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">Palette direction</h3>
        <div className="mt-3 grid gap-2">
          {brief.palette.map((item) => <div key={item.role} className="flex gap-4 rounded-md border border-white/7 px-3 py-2"><span className="w-24 shrink-0 text-[11px] font-medium text-slate-300">{item.role}</span><span className="text-[11px] leading-5 text-slate-500">{item.direction}</span></div>)}
        </div>
      </section>

      <section>
        <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">Page composition</h3>
        <div className="mt-3 space-y-2">
          {brief.sections.map((section, index) => <div key={index} className="grid grid-cols-[2rem_1fr] gap-2 border-b border-white/6 py-3 last:border-0">
            <span className="font-mono text-[10px] text-slate-600">{String(index + 1).padStart(2, "0")}</span>
            <div>
              <div className="flex flex-wrap items-center gap-2"><p className="text-xs font-medium text-slate-200">{section.purpose}</p><span className="text-[9px] uppercase tracking-wide text-slate-600">{weightLabel(section.visualWeight)}</span></div>
              <p className="mt-1 text-xs leading-5 text-slate-500">{section.composition}</p>
            </div>
          </div>)}
        </div>
      </section>

      <section className="grid gap-5 lg:grid-cols-2">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">Mobile art direction</h3>
          <div className="mt-3 space-y-2">{brief.mobileStrategy.map((item, index) => <p key={index} className="text-xs leading-5 text-slate-400">• {item}</p>)}</div>
        </div>
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">Content voice</h3>
          <div className="mt-3 space-y-2">{brief.contentVoice.map((item, index) => <p key={index} className="text-xs leading-5 text-slate-400">• {item}</p>)}</div>
        </div>
      </section>

      <section className="grid gap-5 lg:grid-cols-2">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">Motion philosophy</h3>
          <div className="mt-3 space-y-2">{brief.motion.length ? brief.motion.map((item, index) => <p key={index} className="text-xs leading-5 text-slate-400">• {item}</p>) : <p className="text-xs text-slate-600">No decorative motion required.</p>}</div>
        </div>
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">Quality bar</h3>
          <div className="mt-3 space-y-2">{brief.qualityBar.map((item, index) => <p key={index} className="text-xs leading-5 text-slate-400">✓ {item}</p>)}</div>
        </div>
      </section>

      <section>
        <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">Do not do this</h3>
        <div className="mt-3 grid gap-2 md:grid-cols-2">{brief.avoid.map((item, index) => <p key={index} className="rounded-md border border-red-300/8 bg-red-300/[0.025] px-3 py-2 text-[11px] leading-5 text-red-100/70">{item}</p>)}</div>
      </section>

      {review && <section className="rounded-xl border border-white/8 bg-white/[0.025] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Visual Director</p>
            <p className="mt-1 text-sm font-medium text-slate-200">{review.summary}</p>
          </div>
          <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide ${review.status === "pass" ? "bg-[#a7ff4f]/10 text-[#a7ff4f]" : review.status === "repair" ? "bg-amber-200/10 text-amber-100" : "bg-red-300/10 text-red-200"}`}>{review.status}</span>
        </div>
        {review.dimensions.length > 0 && <div className="mt-4 grid gap-2">
          {review.dimensions.map((item) => <div key={item.dimension} className="grid gap-1 border-t border-white/6 pt-3 first:border-0 first:pt-0 md:grid-cols-[11rem_1fr]">
            <div className="flex items-center gap-2"><span className={`size-1.5 rounded-full ${item.verdict === "pass" ? "bg-[#a7ff4f]" : "bg-amber-200"}`} /><span className="text-[11px] font-medium capitalize text-slate-300">{item.dimension.replaceAll("-", " ")}</span></div>
            <div><p className="text-[11px] leading-5 text-slate-400">{item.evidence}</p>{item.verdict === "repair" && <p className="mt-1 text-[11px] leading-5 text-amber-100/80">Refine: {item.recommendation}</p>}</div>
          </div>)}
        </div>}
        {review.findings.length > 0 && <div className="mt-5 border-t border-white/8 pt-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Concrete findings</p>
          <div className="mt-3 space-y-3">{review.findings.map((finding, index) => <div key={index} className="rounded-md border border-amber-200/10 bg-amber-200/[0.025] p-3">
            <div className="flex flex-wrap items-center gap-2"><span className="rounded bg-amber-200/8 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-amber-100">{finding.severity}</span><span className="text-xs font-medium text-slate-200">{finding.title}</span></div>
            <p className="mt-2 text-[11px] leading-5 text-slate-400">{finding.description}</p>
            {finding.evidence && <p className="mt-2 text-[11px] leading-5 text-slate-500"><span className="text-slate-600">Evidence: </span>{finding.evidence}</p>}
            {finding.remediation && <p className="mt-1 text-[11px] leading-5 text-amber-100/80"><span className="text-amber-100/50">Refine: </span>{finding.remediation}</p>}
          </div>)}</div>
        </div>}
      </section>}
    </div>
  </div>;
}
