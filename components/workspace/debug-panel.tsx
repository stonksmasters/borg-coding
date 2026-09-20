"use client";

import { AlertTriangle, Bug, CheckCircle2, Download, RefreshCw, Radio } from "lucide-react";
import { Button } from "@/components/ui/button";

export type DebugDiagnosticView = {
  id: string;
  severity: "info" | "warning" | "error";
  title: string;
  detail: string;
  scope: string;
  suggestedAction: string;
};

export type DebugSnapshotView = {
  version: 1;
  generatedAt: string;
  readOnly: true;
  task: { id: string; state: string; attempts: number; projectId: string };
  workflow: null | {
    phase: string; loop: string; status: string; nextAction: string; version: number;
    sliceIndex: number | null; sliceTotal: number | null; sliceTitle: string | null;
    pendingCommand: null | { id: string; action: string; createdAt: string; targetSliceIndex: number | null; claimedByTaskId: string | null; claimedAt: string | null };
    lastConsumedCommandId: string | null;
    verification: { status: string; attempt: number };
    recovery: { status: string; category: string | null; resumeAction: string; reason: string };
  };
  approval: null | { status: string; worktreePath: string | null; baseCommit: string | null };
  events: Array<{ id: string; kind: string; category: string; status: string; detail: string; occurredAt: string }>;
  contextPacks: Array<{ id: string; profileId: string; kind: string; stage: string; workflowVersion: number | null; authority: string; characters: number; budgetCharacters: number; manifestCount: number; fingerprint: string; manifest: Array<{ kind: string; path: string; reason: string; characters: number; required: boolean }> }>;
  modelContexts: Array<{ id: string; role: string; model: string; sliceId: string | null; inputSha256: string; manifestCount: number; createdAt: string }>;
  processes: Array<{ id: string; kind: string; label: string; command: string; args: string[]; cwd: string; status: string; exitCode: number | null; stdout: string; stderr: string }>;
  git: { repositoryPath: string | null; worktreePath: string | null; baseCommit: string | null; headCommit: string | null; status: string; worktreeExists: boolean | null };
  checkpoints: unknown[];
  continuations: unknown[];
  roleAssignments: unknown[];
  handoffs: unknown[];
  reviewRuns: unknown[];
  reviewFindings: unknown[];
  diagnostics: DebugDiagnosticView[];
  redaction: { version: 1; sensitiveFieldsRedacted: boolean };
};

function icon(severity: DebugDiagnosticView["severity"]) {
  if (severity === "error") return <AlertTriangle className="size-4 text-red-300" />;
  if (severity === "warning") return <AlertTriangle className="size-4 text-amber-200" />;
  return <CheckCircle2 className="size-4 text-[#a7ff4f]" />;
}

function Cell({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-white/8 bg-white/[0.02] p-3">
    <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-600">{label}</p>
    <p className="mt-1 break-words text-xs text-slate-300">{value}</p>
  </div>;
}

export function DebugPanel({ snapshot, loading, error, streamState, onRefresh, onExport }: {
  snapshot: DebugSnapshotView | null;
  loading: boolean;
  error: string;
  streamState: "disconnected" | "connecting" | "live";
  onRefresh(): void;
  onExport(): void;
}) {
  if (!snapshot) return <div className="grid min-h-0 flex-1 place-items-center p-6 text-center">
    <div><Bug className="mx-auto size-7 text-slate-700" /><p className="mt-3 text-sm text-slate-400">{loading ? "Building read-only debug snapshot…" : error || "No debug snapshot is available."}</p><Button size="sm" variant="outline" onClick={onRefresh} className="mt-4 border-white/10 bg-white/4 text-slate-300"><RefreshCw className="size-3.5" />Refresh</Button></div>
  </div>;

  const errors = snapshot.diagnostics.filter((item) => item.severity === "error").length;
  const warnings = snapshot.diagnostics.filter((item) => item.severity === "warning").length;
  const activeProcesses = snapshot.processes.filter((item) => item.status === "running" || item.status === "starting").length;
  const slice = snapshot.workflow?.sliceIndex !== null && snapshot.workflow?.sliceIndex !== undefined
    ? String(snapshot.workflow.sliceIndex + 1) + "/" + String(snapshot.workflow.sliceTotal ?? "?") + " · " + (snapshot.workflow.sliceTitle ?? "untitled")
    : "—";
  const recovery = snapshot.workflow && snapshot.workflow.recovery.status !== "inactive"
    ? (snapshot.workflow.recovery.category ?? "recovery") + " → " + snapshot.workflow.recovery.resumeAction
    : "inactive";
  const pendingCommand = snapshot.workflow?.pendingCommand ?? null;

  return <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-[#0b0f14] p-4 sm:p-5">
    <div className="mx-auto max-w-6xl space-y-4">
      <section className="rounded-xl border border-white/8 bg-white/[0.02] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><div className="flex items-center gap-2"><Bug className="size-4 text-[#a7ff4f]" /><p className="text-sm font-semibold text-slate-100">BORG Control Plane</p><span className="rounded border border-white/8 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-slate-500">read only</span></div><p className="mt-1 text-xs leading-5 text-slate-500">Canonical workflow, context, runtime, Git, verification, and recovery evidence with secret redaction.</p></div>
          <div className="flex items-center gap-2"><span className="flex items-center gap-1 text-[10px] text-slate-500"><Radio className={"size-3 " + (streamState === "live" ? "text-[#a7ff4f]" : "text-slate-600")} />{streamState}</span><Button size="sm" variant="outline" onClick={onRefresh} disabled={loading} className="border-white/10 bg-white/4 text-slate-300"><RefreshCw className="size-3.5" />Refresh</Button><Button size="sm" variant="outline" onClick={onExport} className="border-white/10 bg-white/4 text-slate-300"><Download className="size-3.5" />Export</Button></div>
        </div>
        {error && <p className="mt-3 rounded border border-amber-300/20 bg-amber-300/5 p-2 text-xs text-amber-100">{error}</p>}
      </section>

      <section className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Cell label="Task" value={snapshot.task.state + " · attempt " + snapshot.task.attempts} />
        <Cell label="Workflow" value={snapshot.workflow ? snapshot.workflow.phase + " · " + snapshot.workflow.status + " · v" + snapshot.workflow.version : "No durable workflow"} />
        <Cell label="Current slice" value={slice} />
        <Cell label="Next action" value={snapshot.workflow?.nextAction ?? "—"} />
        <Cell label="Verification" value={snapshot.workflow ? snapshot.workflow.verification.status + " · attempt " + snapshot.workflow.verification.attempt : "—"} />
        <Cell label="Recovery" value={recovery} />
        <Cell label="Approval" value={snapshot.approval?.status ?? "none"} />
        <Cell label="Runtime" value={activeProcesses ? String(activeProcesses) + " active process(es)" : "no active managed process"} />
      </section>

      {pendingCommand && <section className="rounded-xl border border-white/8 bg-white/[0.015] p-4">
        <p className="text-xs font-semibold text-slate-200">Pending workflow command</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Cell label="Action" value={pendingCommand.action} />
          <Cell label="Command" value={pendingCommand.id} />
          <Cell label="Target slice" value={pendingCommand.targetSliceIndex === null ? "—" : String(pendingCommand.targetSliceIndex + 1)} />
          <Cell label="Claim" value={pendingCommand.claimedByTaskId ? "claimed by " + pendingCommand.claimedByTaskId : "unclaimed"} />
        </div>
        <p className="mt-2 text-[10px] text-slate-600">Created {new Date(pendingCommand.createdAt).toLocaleString()}{pendingCommand.claimedAt ? " · claimed " + new Date(pendingCommand.claimedAt).toLocaleString() : ""}</p>
      </section>}

      <section className="rounded-xl border border-white/8 bg-white/[0.015] p-4">
        <p className="text-xs font-semibold text-slate-200">Invariant diagnostics</p>
        <p className="mt-1 text-[10px] text-slate-600">{errors} errors · {warnings} warnings · {snapshot.diagnostics.length} reported</p>
        <div className="mt-3 grid gap-2">{snapshot.diagnostics.map((item) => <div key={item.id} className="rounded-lg border border-white/8 bg-black/10 p-3"><div className="flex items-start gap-2">{icon(item.severity)}<div><p className="text-xs font-medium text-slate-200">{item.title} <span className="text-[9px] uppercase text-slate-600">{item.scope}</span></p><p className="mt-1 text-[11px] leading-5 text-slate-500">{item.detail}</p><p className="mt-2 text-[10px] text-slate-600"><span className="text-slate-500">Safe next step:</span> {item.suggestedAction}</p></div></div></div>)}</div>
      </section>

      <section className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-white/8 bg-white/[0.015] p-4"><p className="text-xs font-semibold text-slate-200">Repository</p><div className="mt-3 space-y-2 text-[11px] text-slate-500"><p><span className="text-slate-300">Repository:</span> {snapshot.git.repositoryPath ?? "—"}</p><p><span className="text-slate-300">Worktree:</span> {snapshot.git.worktreePath ?? "—"} {snapshot.git.worktreeExists === false && <span className="text-red-300">missing</span>}</p><p><span className="text-slate-300">HEAD:</span> {snapshot.git.headCommit?.slice(0, 12) ?? "—"} · <span className="text-slate-300">Base:</span> {snapshot.git.baseCommit?.slice(0, 12) ?? "—"}</p><pre className="max-h-36 overflow-auto whitespace-pre-wrap rounded bg-black/20 p-2 text-[10px]">{snapshot.git.status || "Working tree clean or unavailable."}</pre></div></div>
        <div className="rounded-xl border border-white/8 bg-white/[0.015] p-4"><p className="text-xs font-semibold text-slate-200">Context</p>{snapshot.contextPacks[0] ? <div className="mt-3 space-y-2 text-[11px] text-slate-500"><p><span className="text-slate-300">Latest:</span> {snapshot.contextPacks[0].kind} / {snapshot.contextPacks[0].stage}</p><p><span className="text-slate-300">Profile:</span> {snapshot.contextPacks[0].profileId}</p><p><span className="text-slate-300">Authority:</span> {snapshot.contextPacks[0].authority} · workflow {snapshot.contextPacks[0].workflowVersion ? "v" + snapshot.contextPacks[0].workflowVersion : "legacy"}</p><p><span className="text-slate-300">Budget:</span> {snapshot.contextPacks[0].characters.toLocaleString()} / {snapshot.contextPacks[0].budgetCharacters.toLocaleString()} chars</p><p>{snapshot.contextPacks.length} ContextPack(s) · {snapshot.modelContexts.length} model context(s)</p><details className="rounded border border-white/8 p-2"><summary className="cursor-pointer text-slate-400">Included context ({snapshot.contextPacks[0].manifestCount})</summary><div className="mt-2 max-h-40 space-y-1 overflow-y-auto">{snapshot.contextPacks[0].manifest.map((item) => <p key={item.path} className="break-all text-[10px]"><span className="text-slate-300">{item.path}</span> — {item.reason}</p>)}</div></details></div> : <p className="mt-3 text-xs text-slate-600">No persisted ContextPack.</p>}</div>
      </section>

      <section className="rounded-xl border border-white/8 bg-white/[0.015] p-4">
        <p className="text-xs font-semibold text-slate-200">Model requests</p>
        <div className="mt-3 space-y-2">{snapshot.modelContexts.length ? snapshot.modelContexts.map((record) => <div key={record.id} className="rounded border border-white/8 p-2 text-[10px] text-slate-500"><span className="text-slate-200">{record.role}</span> · {record.model} · {record.manifestCount} context items · {new Date(record.createdAt).toLocaleTimeString()}<p className="mt-1 truncate font-mono text-slate-700">{record.inputSha256}</p></div>) : <p className="text-xs text-slate-600">No recorded model context.</p>}</div>
      </section>

      <section className="rounded-xl border border-white/8 bg-white/[0.015] p-4"><p className="text-xs font-semibold text-slate-200">Processes</p><div className="mt-3 space-y-2">{snapshot.processes.length ? snapshot.processes.slice().reverse().map((process) => <details key={process.id} className="rounded border border-white/8 p-3"><summary className="cursor-pointer text-[11px] text-slate-400"><span className="text-slate-200">{process.label}</span> · {process.kind} · {process.status}</summary><div className="mt-2 text-[10px] text-slate-600"><p className="font-mono">{process.command} {process.args.join(" ")}</p>{process.stderr && <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/20 p-2 text-red-200/70">{process.stderr}</pre>}{process.stdout && <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/20 p-2">{process.stdout}</pre>}</div></details>) : <p className="text-xs text-slate-600">No managed process evidence.</p>}</div></section>

      <section className="rounded-xl border border-white/8 bg-white/[0.015] p-4"><div className="flex justify-between gap-2"><p className="text-xs font-semibold text-slate-200">Canonical event timeline</p><span className="text-[10px] text-slate-600">{snapshot.events.length} events</span></div><div className="mt-3 max-h-72 space-y-1 overflow-y-auto">{snapshot.events.slice().reverse().map((event) => <div key={event.id} className="grid grid-cols-[76px_110px_1fr] gap-2 rounded px-2 py-1.5 text-[10px] hover:bg-white/[0.025]"><span className="text-slate-700">{new Date(event.occurredAt).toLocaleTimeString()}</span><span className="truncate text-slate-500">{event.kind}</span><span className="break-words text-slate-400">{event.detail}</span></div>)}</div></section>

      <details className="rounded-xl border border-white/8 bg-white/[0.015] p-4"><summary className="cursor-pointer text-xs font-semibold text-slate-300">Raw sanitized snapshot</summary><pre className="mt-3 max-h-[520px] overflow-auto whitespace-pre-wrap break-all rounded bg-black/20 p-3 text-[10px] text-slate-600">{JSON.stringify(snapshot, null, 2)}</pre></details>
      <p className="pb-4 text-center text-[9px] uppercase tracking-[0.12em] text-slate-700">Generated {new Date(snapshot.generatedAt).toLocaleString()} · redaction v{snapshot.redaction.version}</p>
    </div>
  </div>;
}
