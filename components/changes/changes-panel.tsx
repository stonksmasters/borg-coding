"use client";

import { useMemo, useState } from "react";

export type FileChange = {
  path: string;
  previousPath: string | null;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  patch: string;
};

export type ChangeSet = {
  files: FileChange[];
  additions: number;
  deletions: number;
  diff: string;
  clean: boolean;
};

const statusLabel: Record<FileChange["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
};

function Patch({ patch }: { patch: string }) {
  if (!patch.trim()) return <div className="p-5 text-sm text-slate-500">No textual patch is available for this file.</div>;
  return <pre className="min-h-0 overflow-auto p-3 font-mono text-[12px] leading-5">{patch.split("\n").map((line, index) => {
    const tone = line.startsWith("+") && !line.startsWith("+++") ? "bg-emerald-400/10 text-emerald-200"
      : line.startsWith("-") && !line.startsWith("---") ? "bg-red-400/10 text-red-200"
        : line.startsWith("@@") ? "text-sky-300"
          : line.startsWith("diff --git") ? "text-slate-300"
            : "text-slate-500";
    return <div key={index} className={`${tone} whitespace-pre px-2`}>{line || " "}</div>;
  })}</pre>;
}

export function ChangesPanel({ changes }: { changes: ChangeSet }) {
  const [selectedPath, setSelectedPath] = useState<string | null>(changes.files[0]?.path ?? null);
  const selected = useMemo(() => changes.files.find((file) => file.path === selectedPath) ?? changes.files[0] ?? null, [changes.files, selectedPath]);

  if (!changes.files.length) return <div className="grid min-h-0 flex-1 place-items-center p-8 text-center"><div><p className="text-sm font-medium text-slate-300">No worktree changes</p><p className="mt-1 text-xs leading-5 text-slate-500">Files will appear here as the runtime confirms edits through Git.</p></div></div>;

  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="border-b border-white/8 px-3 py-2 text-xs text-slate-400">
      <span className="font-medium text-slate-200">{changes.files.length} file{changes.files.length === 1 ? "" : "s"} changed</span>
      <span className="ml-2 text-emerald-300">+{changes.additions}</span>
      <span className="ml-2 text-red-300">-{changes.deletions}</span>
    </div>
    <div className="flex min-h-0 flex-1 flex-col xl:flex-row">
      <div className="max-h-52 shrink-0 overflow-y-auto border-b border-white/8 xl:max-h-none xl:w-72 xl:border-b-0 xl:border-r">
        {changes.files.map((file) => <button key={file.path} type="button" onClick={() => setSelectedPath(file.path)} className={`flex w-full items-start gap-2 border-b border-white/5 px-3 py-2.5 text-left hover:bg-white/[0.035] ${selected?.path === file.path ? "bg-white/[0.05]" : ""}`}>
          <span className={`mt-0.5 w-4 shrink-0 font-mono text-[11px] font-semibold ${file.status === "added" ? "text-emerald-300" : file.status === "deleted" ? "text-red-300" : file.status === "renamed" ? "text-violet-300" : "text-amber-200"}`}>{statusLabel[file.status]}</span>
          <span className="min-w-0 flex-1">
            <span className="block break-all font-mono text-[11px] leading-4 text-slate-300">{file.path}</span>
            {file.previousPath && <span className="mt-0.5 block break-all font-mono text-[9px] text-slate-600">from {file.previousPath}</span>}
          </span>
          <span className="shrink-0 font-mono text-[9px]"><span className="text-emerald-300">+{file.additions}</span> <span className="text-red-300">-{file.deletions}</span></span>
        </button>)}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden bg-[#070a0f]">
        {selected ? <div className="flex h-full min-h-0 flex-col"><div className="shrink-0 border-b border-white/8 px-3 py-2 font-mono text-[11px] text-slate-300">{selected.path}</div><Patch patch={selected.patch} /></div> : null}
      </div>
    </div>
  </div>;
}
