"use client";

import { ClipboardList, Palette } from "lucide-react";
import { MessageBlockView } from "@/components/chat/message-blocks";
import { parseMessage } from "@/components/chat/message-parser";
import type { DesignBriefView } from "@/components/workspace/design-panel";

export function PlanPanel({ plan, designBrief }: { plan: string | null; designBrief?: DesignBriefView | null }) {
  if (!plan?.trim() && !designBrief) {
    return <div className="grid min-h-0 flex-1 place-items-center overflow-y-auto overscroll-contain p-8 text-center">
      <div>
        <ClipboardList className="mx-auto mb-3 size-6 text-slate-600" />
        <p className="text-sm font-medium text-slate-300">No plan yet</p>
        <p className="mt-1 max-w-sm text-xs leading-5 text-slate-500">BORG&apos;s product plan and approved design direction will stay available here once planning completes.</p>
      </div>
    </div>;
  }

  const blocks = plan?.trim() ? parseMessage(plan) : [];
  return <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5" data-workspace-scroll="plan">
    <div className="mx-auto max-w-3xl space-y-7">
      {designBrief && <section className="rounded-xl border border-white/8 bg-white/[0.025] p-5">
        <div className="flex items-center gap-2 text-[#a7ff4f]"><Palette className="size-4" /><span className="text-[11px] font-semibold uppercase tracking-[0.14em]">Approved design direction</span></div>
        <h2 className="mt-3 text-lg font-semibold tracking-tight text-white">{designBrief.visualDirection}</h2>
        <p className="mt-2 text-sm leading-6 text-slate-400">{designBrief.primaryPromise}</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div><p className="text-[10px] uppercase tracking-wide text-slate-600">Audience</p><p className="mt-1 text-xs leading-5 text-slate-300">{designBrief.audience}</p></div>
          <div><p className="text-[10px] uppercase tracking-wide text-slate-600">Brand character</p><p className="mt-1 text-xs leading-5 text-slate-300">{designBrief.brandCharacter.join(" · ")}</p></div>
          <div><p className="text-[10px] uppercase tracking-wide text-slate-600">Typography</p><p className="mt-1 text-xs leading-5 text-slate-300">{designBrief.typography.hierarchy}</p></div>
          <div><p className="text-[10px] uppercase tracking-wide text-slate-600">Mobile</p><p className="mt-1 text-xs leading-5 text-slate-300">{designBrief.mobileStrategy.join(" ")}</p></div>
        </div>
        <details className="mt-4 border-t border-white/8 pt-3">
          <summary className="cursor-pointer text-xs font-medium text-slate-300">Full design contract</summary>
          <div className="mt-3 grid gap-4 text-xs leading-5 text-slate-400">
            <div><p className="font-medium text-slate-300">Composition</p>{designBrief.sections.map((section, index) => <p key={index} className="mt-1">{index + 1}. {section.purpose} — {section.composition}</p>)}</div>
            <div><p className="font-medium text-slate-300">Quality bar</p>{designBrief.qualityBar.map((item) => <p key={item} className="mt-1">✓ {item}</p>)}</div>
            <div><p className="font-medium text-slate-300">Avoid</p>{designBrief.avoid.map((item) => <p key={item} className="mt-1">• {item}</p>)}</div>
          </div>
        </details>
      </section>}

      {plan?.trim() && <section>
        <div className="mb-5 border-b border-white/8 pb-4">
          <div className="flex items-center gap-2 text-[#a7ff4f]"><ClipboardList className="size-4" /><span className="text-[11px] font-semibold uppercase tracking-[0.14em]">Implementation plan</span></div>
          <p className="mt-2 text-xs leading-5 text-slate-500">This persisted plan remains visible while BORG implements and verifies the work.</p>
        </div>
        <div className="space-y-4">{blocks.map((block, index) => <MessageBlockView key={index} block={block} />)}</div>
      </section>}
    </div>
  </div>;
}
