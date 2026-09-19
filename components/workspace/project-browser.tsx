"use client";

import { useMemo, useState } from "react";
import { ChevronRight, File, Folder, FolderOpen } from "lucide-react";

export type ProjectEntry = { path: string; type: "file" | "directory" };

export function ProjectBrowser({ entries, content, selectedPath, loading, error, onOpen }: { entries: ProjectEntry[]; content: string; selectedPath: string | null; loading: boolean; error: string; onOpen(path: string): void }) {
  const [expanded, setExpanded] = useState(() => new Set([""]));
  const children = useMemo(() => {
    const map = new Map<string, ProjectEntry[]>();
    for (const entry of entries) {
      const parent = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "";
      map.set(parent, [...(map.get(parent) ?? []), entry]);
    }
    for (const list of map.values()) list.sort((a, b) => a.type === b.type ? a.path.localeCompare(b.path) : a.type === "directory" ? -1 : 1);
    return map;
  }, [entries]);
  const toggle = (path: string) => setExpanded((current) => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next; });
  const render = (parent = "", depth = 0): React.ReactNode => (children.get(parent) ?? []).map((entry) => {
    const name = entry.path.split("/").at(-1);
    const open = expanded.has(entry.path);
    return <div key={entry.path}>
      <button type="button" onClick={() => entry.type === "directory" ? toggle(entry.path) : onOpen(entry.path)} className={`flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs ${selectedPath === entry.path ? "bg-white/10 text-white" : "text-slate-400 hover:bg-white/5 hover:text-slate-200"}`} style={{ paddingLeft: `${8 + depth * 14}px` }}>
        {entry.type === "directory" ? <><ChevronRight className={`size-3 transition ${open ? "rotate-90" : ""}`} />{open ? <FolderOpen className="size-3.5 text-[#a7ff4f]" /> : <Folder className="size-3.5 text-slate-500" />}</> : <><span className="w-3" /><File className="size-3.5 text-slate-600" /></>}
        <span className="truncate">{name}</span>
      </button>
      {entry.type === "directory" && open ? render(entry.path, depth + 1) : null}
    </div>;
  });
  return <div className="flex h-full min-w-0 flex-1 overflow-hidden">
    <nav aria-label="Project files" className="w-64 shrink-0 overflow-y-auto border-r border-white/8 p-2">{loading && !entries.length ? <p className="p-3 text-xs text-slate-500">Loading project…</p> : render()}</nav>
    <section className="min-w-0 flex-1 overflow-auto bg-black/10 p-5">{error ? <p className="text-sm text-red-200">{error}</p> : selectedPath ? <><p className="mb-4 font-mono text-[10px] text-slate-500">{selectedPath}</p><pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5 text-slate-300">{content}</pre></> : <div className="grid h-full place-items-center text-sm text-slate-500">Choose a file to inspect it.</div>}</section>
  </div>;
}
