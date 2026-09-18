"use client";

import { ClipboardList } from "lucide-react";
import { MessageBlockView } from "@/components/chat/message-blocks";
import { parseMessage } from "@/components/chat/message-parser";

export function PlanPanel({ plan }: { plan: string | null }) {
  if (!plan?.trim()) {
    return <div className="grid min-h-0 flex-1 place-items-center overflow-y-auto overscroll-contain p-8 text-center">
      <div>
        <ClipboardList className="mx-auto mb-3 size-6 text-slate-600" />
        <p className="text-sm font-medium text-slate-300">No plan yet</p>
        <p className="mt-1 max-w-sm text-xs leading-5 text-slate-500">BORG&apos;s implementation plan will stay available here once planning completes.</p>
      </div>
    </div>;
  }

  const blocks = parseMessage(plan);
  return <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5" data-workspace-scroll="plan">
    <div className="mx-auto max-w-2xl">
      <div className="mb-5 border-b border-white/8 pb-4">
        <div className="flex items-center gap-2 text-[#a7ff4f]"><ClipboardList className="size-4" /><span className="text-[11px] font-semibold uppercase tracking-[0.14em]">Implementation plan</span></div>
        <p className="mt-2 text-xs leading-5 text-slate-500">This is the persisted plan for the active task. It remains visible while BORG implements and verifies the work.</p>
      </div>
      <div className="space-y-4">{blocks.map((block, index) => <MessageBlockView key={index} block={block} />)}</div>
    </div>
  </div>;
}
