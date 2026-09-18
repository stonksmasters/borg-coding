"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CircleStop, CornerDownLeft, TerminalSquare } from "lucide-react";
import { Button } from "@/components/ui/button";

export type TaskProcessStatus = "starting" | "running" | "completed" | "failed" | "stopped";
export type TaskProcessKind = "command" | "dev_server" | "test" | "build" | "verification";

export interface TaskProcess {
  id: string;
  taskId: string;
  kind: TaskProcessKind;
  label: string;
  command: string;
  args: string[];
  cwd: string;
  url: string | null;
  pid: number | null;
  status: TaskProcessStatus;
  exitCode: number | null;
  timedOut: boolean;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  stdout: string;
  stderr: string;
}

export interface TaskProcessEvent {
  type: "PROCESS_STARTED" | "PROCESS_OUTPUT" | "PROCESS_STATE";
  payload: {
    process?: TaskProcess;
    processId?: string;
    stream?: "stdout" | "stderr";
    text?: string;
    occurredAt?: string;
  };
  occurredAt: string;
}

interface OutputChunk {
  stream: "stdout" | "stderr";
  text: string;
  occurredAt: string;
}

interface TerminalEntry {
  process: TaskProcess;
  output: OutputChunk[];
}

function formatDuration(milliseconds: number | null): string {
  if (milliseconds === null) return "";
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  const seconds = milliseconds / 1_000;
  return seconds < 60 ? `${seconds.toFixed(seconds < 10 ? 1 : 0)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function processTone(status: TaskProcessStatus) {
  if (status === "completed") return "text-[#a7ff4f]";
  if (status === "failed") return "text-red-300";
  if (status === "stopped") return "text-amber-200";
  return "text-sky-300";
}

export function TerminalPanel({
  processes,
  events,
  onStop,
}: {
  processes: TaskProcess[];
  events: TaskProcessEvent[];
  onStop(processId: string): void | Promise<void>;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [follow, setFollow] = useState(true);
  const [stopping, setStopping] = useState<string | null>(null);

  const entries = useMemo(() => {
    const map = new Map<string, TerminalEntry>();
    const ensure = (process: TaskProcess) => {
      const current = map.get(process.id);
      if (current) {
        current.process = { ...current.process, ...process };
        return current;
      }
      const created = { process: { ...process, args: [...process.args] }, output: [] };
      map.set(process.id, created);
      return created;
    };

    for (const event of events) {
      const snapshot = event.payload.process;
      if (snapshot) ensure(snapshot);
      if (event.type === "PROCESS_OUTPUT" && event.payload.processId && event.payload.stream && event.payload.text) {
        const existing = map.get(event.payload.processId);
        if (existing) existing.output.push({
          stream: event.payload.stream,
          text: event.payload.text,
          occurredAt: event.payload.occurredAt ?? event.occurredAt,
        });
      }
    }
    for (const process of processes) ensure(process);

    for (const entry of map.values()) {
      if (!entry.output.length) {
        if (entry.process.stdout) entry.output.push({ stream: "stdout", text: entry.process.stdout, occurredAt: entry.process.completedAt ?? entry.process.startedAt });
        if (entry.process.stderr) entry.output.push({ stream: "stderr", text: entry.process.stderr, occurredAt: entry.process.completedAt ?? entry.process.startedAt });
      }
    }
    return [...map.values()].sort((a, b) => a.process.startedAt.localeCompare(b.process.startedAt));
  }, [events, processes]);

  const outputVersion = events.length + processes.map((process) => `${process.id}:${process.status}:${process.exitCode ?? ""}`).join("|").length;
  useEffect(() => {
    if (!follow) return;
    const target = scrollRef.current;
    if (target) target.scrollTop = target.scrollHeight;
  }, [follow, outputVersion]);

  const running = processes.filter((process) => process.status === "starting" || process.status === "running");

  async function stop(processId: string) {
    setStopping(processId);
    try { await onStop(processId); }
    finally { setStopping(null); }
  }

  if (!entries.length) {
    return <div className="grid min-h-0 flex-1 place-items-center overflow-y-auto overscroll-contain p-8 text-center">
      <div>
        <TerminalSquare className="mx-auto mb-3 size-6 text-slate-600" />
        <p className="text-sm font-medium text-slate-300">No terminal activity yet</p>
        <p className="mt-1 max-w-sm text-xs leading-5 text-slate-500">Commands, builds, tests, and development-server output will appear here as BORG runs them.</p>
      </div>
    </div>;
  }

  return <div className="flex min-h-0 flex-1 flex-col bg-[#070a0f]">
    <div className="flex shrink-0 items-center justify-between border-b border-white/8 px-3 py-2">
      <div className="flex items-center gap-2 text-xs text-slate-400">
        <TerminalSquare className="size-3.5" />
        <span>{entries.length} process{entries.length === 1 ? "" : "es"}</span>
        {running.length > 0 && <span className="rounded bg-sky-300/8 px-1.5 py-0.5 text-sky-200">{running.length} running</span>}
      </div>
      {!follow && <Button size="sm" variant="ghost" onClick={() => setFollow(true)} className="h-7 gap-1.5 text-xs text-slate-400"><CornerDownLeft className="size-3" />Follow output</Button>}
    </div>
    <div
      ref={scrollRef}
      data-workspace-scroll="terminal"
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      onScroll={(event) => {
        const element = event.currentTarget;
        const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
        setFollow(distance < 48);
      }}
    >
      {entries.map((entry) => {
        const process = entry.process;
        const active = process.status === "starting" || process.status === "running";
        const command = [process.command, ...process.args].join(" ");
        return <section key={process.id} className="border-b border-white/8 last:border-b-0">
          <div className="sticky top-0 z-[1] flex items-start justify-between gap-3 border-b border-white/6 bg-[#0b0f15]/95 px-4 py-3 backdrop-blur">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`size-1.5 rounded-full ${active ? "animate-pulse bg-sky-300" : process.status === "completed" ? "bg-[#a7ff4f]" : process.status === "failed" ? "bg-red-300" : "bg-amber-200"}`} />
                <span className="text-xs font-medium text-slate-200">{process.label}</span>
                <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[9px] uppercase text-slate-500">{process.kind.replace("_", " ")}</span>
              </div>
              <p className="mt-1 break-all font-mono text-[11px] leading-5 text-slate-400">$ {command}</p>
              <p className="mt-0.5 truncate font-mono text-[9px] text-slate-600">{process.cwd}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className={`text-[10px] font-medium uppercase tracking-wide ${processTone(process.status)}`}>
                {process.status}{process.exitCode !== null ? ` · exit ${process.exitCode}` : ""}{process.timedOut ? " · timeout" : ""}
                {process.durationMs !== null ? ` · ${formatDuration(process.durationMs)}` : ""}
              </span>
              {active && <Button size="sm" variant="outline" disabled={stopping === process.id} onClick={() => void stop(process.id)} className="h-7 gap-1.5 border-red-300/15 bg-transparent px-2 text-[10px] text-red-200 hover:bg-red-300/8"><CircleStop className="size-3" />Stop</Button>}
            </div>
          </div>
          <pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-[12px] leading-5">
            {entry.output.length
              ? entry.output.map((chunk, index) => <span key={`${chunk.occurredAt}:${index}`} className={chunk.stream === "stderr" ? "text-red-200" : "text-slate-300"}>{chunk.text}</span>)
              : <span className="text-slate-600">{active ? "Process is running; waiting for output…" : "No output captured."}</span>}
          </pre>
        </section>;
      })}
    </div>
  </div>;
}
