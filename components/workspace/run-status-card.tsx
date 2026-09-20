"use client";

import { Check, Circle, TriangleAlert } from "lucide-react";

export interface RunView {
  phase: string;
  slice: { index: number; total: number; title: string; outcome: string } | null;
  stage: "planning" | "awaiting_approval" | "implementing" | "repairing" | "verifying" | "visual_review" | "reviewing" | "delivering" | "ready" | "blocked" | "paused";
  headline: string;
  detail: string;
  currentAction: string;
  verification: { status: "pending" | "passed" | "failed"; visualStatus: string | null };
  recovery: { status: string; category: string | null; previousTaskState: string | null; checkpointId: string | null; resumeAction: string; reason: string } | null;
  repair: { attempt: number; maximum: number | null } | null;
  blocker: { title: string; detail: string; action: string } | null;
  nextAction: string;
  updatedAt: string;
}

const stageOrder = ["planning", "implementing", "verifying", "ready"] as const;

function stageIndex(stage: RunView["stage"]) {
  if (stage === "awaiting_approval") return 0;
  if (stage === "repairing") return 1;
  if (stage === "visual_review" || stage === "reviewing" || stage === "delivering") return 2;
  if (stage === "blocked" || stage === "paused") return -1;
  return stageOrder.indexOf(stage as typeof stageOrder[number]);
}

export function RunStatusCard({ run, active }: { run: RunView; active: boolean }) {
  const current = stageIndex(run.stage);
  const blocked = Boolean(run.blocker);
  return <section role="status" aria-live="polite" className={`rounded-xl border p-4 ${blocked ? "border-red-400/25 bg-red-400/[0.04]" : "border-[#a7ff4f]/20 bg-[#a7ff4f]/5"}`}>
    <div className="flex items-start gap-3">
      <span className={`mt-1.5 size-2 shrink-0 rounded-full ${blocked ? "bg-red-300" : "bg-[#a7ff4f]"} ${active ? "animate-pulse" : ""}`} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className={`text-sm font-semibold ${blocked ? "text-red-100" : "text-[#d9ffb5]"}`}>{run.headline}</p>
          {run.slice && <span className="rounded bg-white/5 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-slate-400">Slice {run.slice.index + 1}/{run.slice.total}</span>}
          {run.repair && <span className="rounded bg-amber-200/8 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-100">Repair {run.repair.attempt}{run.repair.maximum ? `/${run.repair.maximum}` : ""}</span>}
          {run.recovery && <span className="rounded bg-red-200/8 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-red-100">{run.recovery.category ?? "recovery"}</span>}
        </div>
        <p className="mt-1 text-xs leading-5 text-slate-400">{run.blocker?.detail ?? run.detail}</p>
        {run.slice?.outcome && <p className="mt-2 text-[11px] leading-5 text-slate-500"><span className="text-slate-300">Outcome:</span> {run.slice.outcome}</p>}
      </div>
    </div>

    {!blocked && <div className="mt-4 grid grid-cols-4 gap-1">
      {stageOrder.map((stage, index) => {
        const done = current >= index;
        const labels = { planning: "Plan", implementing: "Build", verifying: "Verify", ready: "Ready" };
        return <div key={stage} className="min-w-0">
          <div className={`h-1 rounded-full ${done ? "bg-[#a7ff4f]" : "bg-white/8"}`} />
          <p className={`mt-1 truncate text-[9px] uppercase tracking-wide ${done ? "text-[#cfff9e]" : "text-slate-700"}`}>{labels[stage]}</p>
        </div>;
      })}
    </div>}

    <div className="mt-3 grid gap-2 text-[11px] text-slate-500 sm:grid-cols-2">
      <p className="truncate"><span className="text-slate-300">Now:</span> {run.currentAction.replaceAll("_", " ")}</p>
      <p className="truncate"><span className="text-slate-300">Next:</span> {run.recovery?.resumeAction ?? run.blocker?.action ?? run.nextAction}</p>
      <p><span className="text-slate-300">Technical verification:</span> {run.verification.status}</p>
      <p><span className="text-slate-300">Visual / product quality:</span> {run.verification.visualStatus ?? "pending"}</p>
      <p className="flex items-center gap-1.5 sm:col-span-2"><span className="text-slate-300">State:</span>{blocked ? <TriangleAlert className="size-3 text-red-300" /> : run.stage === "ready" ? <Check className="size-3 text-[#a7ff4f]" /> : <Circle className="size-3 text-slate-500" />}{run.stage.replaceAll("_", " ")}</p>
    </div>
  </section>;
}
