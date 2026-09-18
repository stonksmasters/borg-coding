"use client";

import { Check, Circle, TriangleAlert } from "lucide-react";

export type AgentActivity = {
  id: string;
  taskId?: string;
  phase: "planning" | "inspecting" | "editing" | "testing" | "building" | "verifying" | "reviewing";
  status: "started" | "progress" | "completed" | "failed";
  title: string;
  detail: string | null;
  files: string[];
  occurredAt: string;
};

function ActivityIcon({ status }: { status: AgentActivity["status"] }) {
  if (status === "completed") return <Check className="size-3.5 text-[#a7ff4f]" />;
  if (status === "failed") return <TriangleAlert className="size-3.5 text-red-300" />;
  return <Circle className={`size-3.5 ${status === "started" || status === "progress" ? "fill-[#a7ff4f]/25 text-[#a7ff4f]" : "text-slate-600"}`} />;
}

export function ActivityFeed({ activities }: { activities: AgentActivity[] }) {
  const visible = activities.slice(-8);
  if (!visible.length) return null;
  return <section aria-label="BORG work activity" className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.018]">
    <div className="flex items-center justify-between border-b border-white/8 px-4 py-2.5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">What BORG is doing</p>
      <span className="text-[10px] text-slate-600">{visible.length} update{visible.length === 1 ? "" : "s"}</span>
    </div>
    <div className="divide-y divide-white/6">
      {visible.map((activity) => <article key={activity.id} className="flex gap-3 px-4 py-3">
        <div className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-white/[0.035]"><ActivityIcon status={activity.status} /></div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-slate-200">{activity.title}</p>
            <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-slate-500">{activity.phase}</span>
          </div>
          {activity.detail && <p className="mt-1 text-xs leading-5 text-slate-400">{activity.detail}</p>}
          {activity.files.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{activity.files.map((path) => <span key={path} className="max-w-full truncate rounded border border-sky-300/10 bg-sky-300/[0.035] px-2 py-1 font-mono text-[10px] text-sky-200">{path}</span>)}</div>}
        </div>
      </article>)}
    </div>
  </section>;
}
