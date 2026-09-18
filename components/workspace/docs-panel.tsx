"use client";

import { useState } from "react";

export type BuildDoc = { path: string; title: string; content: string };

export function DocsPanel({ docs }: { docs: BuildDoc[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const active = docs.find((doc) => doc.path === selected) ?? docs[0];
  if (!active) return <div className="grid h-full flex-1 place-items-center p-6 text-center text-sm text-slate-500">Build docs will appear here when the first slice is approved.</div>;
  return <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden md:flex-row">
    <nav aria-label="Build documents" className="flex shrink-0 gap-1 overflow-x-auto border-b border-white/10 p-3 md:w-48 md:flex-col md:overflow-y-auto md:border-b-0 md:border-r">
      {docs.map((doc) => <button key={doc.path} type="button" onClick={() => setSelected(doc.path)} aria-current={active.path === doc.path ? "page" : undefined} className={`shrink-0 rounded-md px-3 py-2 text-left text-xs capitalize ${active.path === doc.path ? "bg-white/10 text-white" : "text-slate-400 hover:bg-white/5 hover:text-slate-200"}`}>{doc.title}</button>)}
    </nav>
    <article className="min-w-0 flex-1 overflow-y-auto p-5 sm:p-7">
      <p className="mb-5 font-mono text-[10px] text-slate-600">{active.path}</p>
      <div className="space-y-2 text-sm leading-6 text-slate-300">{active.content.split("\n").map((line, index) => line.startsWith("# ")
        ? <h1 key={index} className="mb-4 text-xl font-semibold text-white">{line.slice(2)}</h1>
        : line.startsWith("## ") ? <h2 key={index} className="mt-6 text-base font-semibold text-slate-100">{line.slice(3)}</h2>
        : line ? <p key={index} className="whitespace-pre-wrap break-words">{line}</p> : null)}</div>
    </article>
  </div>;
}
