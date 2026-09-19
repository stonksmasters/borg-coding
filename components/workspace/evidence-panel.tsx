"use client";

import { Check, CircleAlert, BadgeCheck, ShieldCheck } from "lucide-react";
import type { DesignReviewView } from "./design-panel";
import { Button } from "@/components/ui/button";

export function EvidencePanel({
  verificationStatus,
  designReview,
  refinementCount,
  maxRefinements,
  blockingFindings,
  baselineCandidates,
  baselineBusy,
  baselineError,
  onAcceptBaselines,
  onOpenReviewHistory,
  onOpenLogs,
}: {
  verificationStatus: "pending" | "passed" | "failed";
  designReview: DesignReviewView | null;
  refinementCount: number;
  maxRefinements: number;
  blockingFindings: number;
  baselineCandidates: Array<{ profileId: string; screenshotName: string }>;
  baselineBusy: boolean;
  baselineError: string;
  onAcceptBaselines(): void | Promise<void>;
  onOpenReviewHistory(): void;
  onOpenLogs(): void;
}) {
  return <div className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-7">
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="border-b border-white/8 pb-5">
        <div className="flex items-center gap-2 text-[#a7ff4f]"><ShieldCheck className="size-4" /><span className="text-[11px] font-semibold uppercase tracking-[0.14em]">Verification evidence</span></div>
        <h2 className="mt-3 text-xl font-semibold tracking-tight text-white">Did the current slice actually pass?</h2>
        <p className="mt-2 text-sm leading-6 text-slate-500">Functional checks, visual review, and unresolved findings are kept separate from the implementation agent&apos;s own claims.</p>
      </header>

      <section className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-white/8 bg-white/[0.025] p-4">
          <p className="text-[10px] uppercase tracking-wide text-slate-500">Deterministic checks</p>
          <p className={`mt-2 text-sm font-medium ${verificationStatus === "passed" ? "text-[#a7ff4f]" : verificationStatus === "failed" ? "text-red-200" : "text-slate-300"}`}>{verificationStatus}</p>
        </div>
        <div className="rounded-lg border border-white/8 bg-white/[0.025] p-4">
          <p className="text-[10px] uppercase tracking-wide text-slate-500">Visual Director</p>
          <p className={`mt-2 text-sm font-medium ${designReview?.status === "pass" ? "text-[#a7ff4f]" : designReview?.status === "repair" ? "text-amber-100" : "text-slate-300"}`}>{designReview?.status ?? "not required yet"}</p>
        </div>
        <div className="rounded-lg border border-white/8 bg-white/[0.025] p-4">
          <p className="text-[10px] uppercase tracking-wide text-slate-500">Blocking findings</p>
          <p className={`mt-2 text-sm font-medium ${blockingFindings ? "text-red-200" : "text-[#a7ff4f]"}`}>{blockingFindings}</p>
        </div>
      </section>

      {baselineCandidates.length > 0 && <section className="rounded-xl border border-sky-300/20 bg-sky-300/[0.04] p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-xl">
            <div className="flex items-center gap-2 text-sky-100"><ImageCheck className="size-4" /><p className="text-sm font-medium">Visual baseline approval required</p></div>
            <p className="mt-2 text-xs leading-5 text-slate-400">These screenshots passed the current implementation checks but do not yet have an operator-approved comparison baseline. BORG will not checkpoint this slice until you accept them.</p>
            <div className="mt-3 flex flex-wrap gap-1.5">{baselineCandidates.map((candidate) => <span key={`${candidate.profileId}:${candidate.screenshotName}`} className="rounded border border-sky-300/10 bg-sky-300/[0.035] px-2 py-1 font-mono text-[10px] text-sky-100">{candidate.profileId}/{candidate.screenshotName}</span>)}</div>
            {baselineError && <p className="mt-3 text-xs text-red-200">{baselineError}</p>}
          </div>
          <Button size="sm" disabled={baselineBusy} onClick={() => void onAcceptBaselines()} className="bg-sky-200 text-sky-950 hover:bg-sky-100">{baselineBusy ? "Accepting…" : "Accept baselines"}</Button>
        </div>
      </section>}

      {designReview && <section className="rounded-xl border border-white/8 bg-white/[0.025] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Visual quality review</p><p className="mt-2 text-sm leading-6 text-slate-300">{designReview.summary}</p></div>
          {refinementCount > 0 && <span className="rounded-full border border-amber-200/10 bg-amber-200/5 px-2.5 py-1 text-[10px] text-amber-100">Refinement {refinementCount}/{maxRefinements}</span>}
        </div>
        {designReview.dimensions.length > 0 && <div className="mt-4 space-y-2">
          {designReview.dimensions.map((item) => <div key={item.dimension} className="grid gap-1 border-t border-white/6 pt-3 first:border-0 first:pt-0 sm:grid-cols-[11rem_1fr]">
            <div className="flex items-center gap-2">{item.verdict === "pass" ? <Check className="size-3 text-[#a7ff4f]" /> : <CircleAlert className="size-3 text-amber-200" />}<span className="text-[11px] font-medium capitalize text-slate-300">{item.dimension.replaceAll("-", " ")}</span></div>
            <div><p className="text-[11px] leading-5 text-slate-400">{item.evidence}</p>{item.verdict === "repair" && <p className="mt-1 text-[11px] leading-5 text-amber-100/80">Refine: {item.recommendation}</p>}</div>
          </div>)}
        </div>}
      </section>}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={onOpenReviewHistory} className="border-white/10 bg-transparent text-slate-300">Review findings</Button>
        <Button size="sm" variant="outline" onClick={onOpenLogs} className="border-white/10 bg-transparent text-slate-300">Technical logs</Button>
      </div>
    </div>
  </div>;
}
