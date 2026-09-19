"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type EnvironmentVariable = { name: string; hasValue: boolean };

export function EnvironmentPanel({ variables, busy, error, onSave, onDelete }: { variables: EnvironmentVariable[]; busy: boolean; error: string; onSave(name: string, value: string): Promise<void>; onDelete(name: string): Promise<void> }) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  return <div className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-7"><div className="mx-auto max-w-3xl space-y-6">
    <header><p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#a7ff4f]">Environment</p><h2 className="mt-3 text-xl font-semibold text-white">Project variables</h2><p className="mt-2 text-sm leading-6 text-slate-500">Values stay hidden after they are saved. BORG stores them through the desktop credential store and injects them only into this project&apos;s task processes.</p></header>
    <form className="grid gap-2 rounded-xl border border-white/8 bg-white/[0.02] p-4 sm:grid-cols-[1fr_1fr_auto]" onSubmit={(event) => { event.preventDefault(); void onSave(name, value).then(() => { setName(""); setValue(""); }); }}>
      <Input value={name} onChange={(event) => setName(event.target.value.toUpperCase())} placeholder="VARIABLE_NAME" className="border-white/10 bg-black/20 font-mono" />
      <Input value={value} onChange={(event) => setValue(event.target.value)} placeholder="Value" type="password" className="border-white/10 bg-black/20" />
      <Button disabled={busy || !name || !value} className="bg-[#a7ff4f] text-[#071007]"><Plus className="size-4" />Save</Button>
    </form>
    {error && <p className="text-sm text-red-200">{error}</p>}
    <div className="divide-y divide-white/6 rounded-xl border border-white/8">{variables.length ? variables.map((variable) => <div key={variable.name} className="flex items-center justify-between gap-3 px-4 py-3"><div><p className="font-mono text-xs text-slate-200">{variable.name}</p><p className="mt-1 text-[10px] text-slate-600">{variable.hasValue ? "•••••••• · configured" : "empty"}</p></div><Button size="icon-sm" variant="ghost" disabled={busy} aria-label={`Remove ${variable.name}`} onClick={() => void onDelete(variable.name)} className="text-slate-600 hover:text-red-200"><Trash2 className="size-3.5" /></Button></div>) : <p className="p-5 text-sm text-slate-500">No project variables are configured.</p>}</div>
  </div></div>;
}
