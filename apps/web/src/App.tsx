import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

type PermissionMode = "ask" | "edit" | "agent";
type InspectorTab = "diff" | "terminal" | "context";
type Message = { id: string; role: "user" | "assistant"; text: string };
type Health = { model?: { name: string; available: boolean }; runtime?: { id: string; available: boolean } };
type Approval = { approvalId: string; taskId: string; tool: string; input: Record<string, unknown>; reason?: string };
type WorkspaceSummary = { root: string; generatedAt: string; fileCount: number; instructionFiles: string[]; docFiles: string[]; metadataFiles: string[]; languages: Record<string, number> };
type DiffState = { status: string; diff: string };
type AgentEvent = {
  type: string;
  taskId: string;
  message?: string;
  text?: string;
  error?: string;
  approvalId?: string;
  approved?: boolean;
  tool?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  reason?: string;
  stream?: "stdout" | "stderr" | "info";
  summary?: WorkspaceSummary;
  selectedFiles?: string[];
  status?: string;
  diff?: string;
  ok?: boolean;
};

const API = "http://127.0.0.1:8787";
const EMPTY_DIFF: DiffState = { status: "", diff: "" };

function loadRecentWorkspaces(): string[] {
  try {
    const value = window.localStorage.getItem("borg.recentWorkspaces");
    return value ? JSON.parse(value) as string[] : [];
  } catch {
    return [];
  }
}

function upsertApproval(items: Approval[], approval: Approval): Approval[] {
  const index = items.findIndex((item) => item.approvalId === approval.approvalId);
  if (index === -1) return [...items, approval];
  return items.map((item, itemIndex) => itemIndex === index ? approval : item);
}

function clipTerminal(value: string): string {
  return value.length > 70000 ? value.slice(-70000) : value;
}

export default function App() {
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("ask");
  const [health, setHealth] = useState<Health>({});
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [workspaceSummary, setWorkspaceSummary] = useState<WorkspaceSummary | null>(null);
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>(loadRecentWorkspaces);
  const [contextFiles, setContextFiles] = useState<string[]>([]);
  const [diffState, setDiffState] = useState<DiffState>(EMPTY_DIFF);
  const [terminal, setTerminal] = useState("");
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("diff");
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [activeTask, setActiveTask] = useState<string | null>(null);
  const activeTaskRef = useRef<string | null>(null);
  const [latestTaskId, setLatestTaskId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [activity, setActivity] = useState<string[]>([]);

  useEffect(() => {
    fetch(`${API}/api/health`).then((response) => response.json()).then(setHealth).catch(() => setHealth({}));

    const socket = new WebSocket("ws://127.0.0.1:8787/events");
    socket.onmessage = (message) => {
      const event = JSON.parse(message.data) as AgentEvent;
      if (event.taskId !== activeTaskRef.current) return;

      if (event.type === "agent.status" && event.message) setActivity((items) => [...items, event.message!]);
      if (event.type === "workspace.indexed" && event.summary) {
        setWorkspaceSummary(event.summary);
        setWorkspaceRoot(event.summary.root);
        setContextFiles(event.selectedFiles ?? []);
        setActivity((items) => [...items, `Context ready: ${event.selectedFiles?.length ?? 0} files selected`]);
      }
      if (event.type === "tool.started" && event.tool) setActivity((items) => [...items, `Running ${event.tool}`]);
      if (event.type === "tool.output" && event.text) {
        setTerminal((value) => clipTerminal(`${value}${event.text}`));
      }
      if (event.type === "tool.completed" && event.tool) setActivity((items) => [...items, `${event.tool} completed`]);
      if (event.type === "verification.completed") setActivity((items) => [...items, event.ok ? "Verification passed" : "Verification failed"]);
      if (event.type === "diff.updated") setDiffState({ status: event.status ?? "", diff: event.diff ?? "" });
      if (event.type === "approval.required" && event.approvalId && event.tool && event.input) {
        const approval: Approval = { approvalId: event.approvalId, taskId: event.taskId, tool: event.tool, input: event.input, reason: event.reason };
        setApprovals((items) => upsertApproval(items, approval));
      }
      if (event.type === "approval.resolved" && event.approvalId) {
        setApprovals((items) => items.filter((item) => item.approvalId !== event.approvalId));
      }
    };
    return () => socket.close();
  }, []);

  useEffect(() => {
    if (!busy || !activeTask) return;
    let cancelled = false;

    const recoverApprovals = async () => {
      try {
        const response = await fetch(`${API}/api/approvals`);
        if (!response.ok || cancelled) return;
        const body = await response.json() as { approvals?: Approval[] };
        const matching = (body.approvals ?? []).filter((approval) => approval.taskId === activeTask);
        if (!cancelled) setApprovals((items) => matching.reduce(upsertApproval, items.filter((item) => item.taskId !== activeTask)));
      } catch {
        // WebSocket is primary; this polling path only recovers missed approval events.
      }
    };

    void recoverApprovals();
    const interval = window.setInterval(() => void recoverApprovals(), 750);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeTask, busy]);

  const status = useMemo(() => {
    if (!health.model) return "Server offline";
    return health.model.available ? `${health.model.name} online` : `${health.model.name} unavailable`;
  }, [health]);

  const languageSummary = useMemo(() => {
    if (!workspaceSummary) return "";
    return Object.entries(workspaceSummary.languages).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => `${name} ${count}`).join(" · ");
  }, [workspaceSummary]);

  function rememberWorkspace(root: string) {
    setRecentWorkspaces((items) => {
      const next = [root, ...items.filter((item) => item !== root)].slice(0, 6);
      window.localStorage.setItem("borg.recentWorkspaces", JSON.stringify(next));
      return next;
    });
  }

  async function refreshDiff(root = workspaceRoot) {
    if (!root.trim()) return;
    try {
      const response = await fetch(`${API}/api/workspace/diff?root=${encodeURIComponent(root.trim())}`);
      const body = await response.json() as DiffState & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Diff request failed with ${response.status}`);
      setDiffState({ status: body.status ?? "", diff: body.diff ?? "" });
    } catch (error) {
      setDiffState({ status: "", diff: error instanceof Error ? error.message : String(error) });
    }
  }

  async function openWorkspace(root = workspaceRoot) {
    if (indexing) return;
    setIndexing(true);
    setActivity((items) => [...items, "Indexing workspace"]);
    try {
      const response = await fetch(`${API}/api/workspace/index`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceRoot: root.trim() || undefined })
      });
      const body = await response.json() as { root?: string; summary?: WorkspaceSummary; error?: string };
      if (!response.ok || !body.root || !body.summary) throw new Error(body.error ?? `Workspace index failed with ${response.status}`);
      setWorkspaceRoot(body.root);
      setWorkspaceSummary(body.summary);
      setContextFiles([]);
      rememberWorkspace(body.root);
      setActivity((items) => [...items, `Indexed ${body.summary!.fileCount} files`]);
      await refreshDiff(body.root);
    } catch (error) {
      setActivity((items) => [...items, `Workspace error: ${error instanceof Error ? error.message : String(error)}`]);
    } finally {
      setIndexing(false);
    }
  }

  async function resolveApproval(approvalId: string, approved: boolean) {
    const response = await fetch(`${API}/api/approvals/${encodeURIComponent(approvalId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approved })
    });
    if (!response.ok) throw new Error(`Approval request failed with ${response.status}`);
    setApprovals((items) => items.filter((item) => item.approvalId !== approvalId));
  }

  async function undoLastChange() {
    if (!latestTaskId || !workspaceRoot.trim() || undoing) return;
    setUndoing(true);
    try {
      const response = await fetch(`${API}/api/workspace/undo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceRoot: workspaceRoot.trim(), taskId: latestTaskId })
      });
      const body = await response.json() as { restored?: { path?: string } | null; status?: string; diff?: string; error?: string };
      if (!response.ok) throw new Error(body.error ?? `Undo failed with ${response.status}`);
      setDiffState({ status: body.status ?? "", diff: body.diff ?? "" });
      setActivity((items) => [...items, body.restored?.path ? `Restored ${body.restored.path}` : "No remaining checkpoint for this task"]);
    } catch (error) {
      setActivity((items) => [...items, `Undo error: ${error instanceof Error ? error.message : String(error)}`]);
    } finally {
      setUndoing(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = prompt.trim();
    if (!value || busy) return;
    const taskId = crypto.randomUUID();
    activeTaskRef.current = taskId;
    setLatestTaskId(taskId);
    setPrompt("");
    setBusy(true);
    setActiveTask(taskId);
    setApprovals([]);
    setContextFiles([]);
    setTerminal("");
    setActivity(["Starting task"]);
    setMessages((items) => [...items, { id: crypto.randomUUID(), role: "user", text: value }]);

    try {
      const response = await fetch(`${API}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId, prompt: value, permissionMode, ...(workspaceRoot.trim() ? { workspaceRoot: workspaceRoot.trim() } : {}) })
      });
      const body = await response.json() as { text?: string; error?: string };
      const text = body.text ?? body.error ?? "BORG returned no output.";
      setMessages((items) => [...items, { id: crypto.randomUUID(), role: "assistant", text }]);
      if (workspaceRoot.trim()) await refreshDiff(workspaceRoot);
    } finally {
      activeTaskRef.current = null;
      setBusy(false);
      setActiveTask(null);
      setApprovals([]);
    }
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="mark">B</span><div><strong>BORG</strong><small>CODING</small></div></div>
        <button className="newTask" onClick={() => { setMessages([]); setActivity([]); setTerminal(""); setContextFiles([]); }}>+ New task</button>
        <div className="sectionLabel">Workspace</div>
        <div className="repoCard"><span className="dot" />{workspaceSummary?.root || workspaceRoot || "No workspace opened"}</div>
        {workspaceSummary && <div className="workspaceMeta">{workspaceSummary.fileCount} files{languageSummary ? ` · ${languageSummary}` : ""}</div>}
        {recentWorkspaces.length > 0 && <>
          <div className="sectionLabel">Recent</div>
          <div className="recentList">{recentWorkspaces.map((root) => <button key={root} onClick={() => { setWorkspaceRoot(root); void openWorkspace(root); }} title={root}>{root}</button>)}</div>
        </>}
        <div className="sectionLabel">Activity</div>
        <div className="activityList">{activity.slice(-10).map((item, index) => <div key={`${item}-${index}`}>{item}</div>)}</div>
        <div className="sidebarFooter"><span className={health.model?.available ? "status ok" : "status"} />{status}</div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div className="titleBlock"><h1>BORG Coding</h1><p>Local engineering agent</p></div>
          <div className="workspaceChooser">
            <input className="workspaceInput" value={workspaceRoot} onChange={(event) => setWorkspaceRoot(event.target.value)} placeholder="Workspace root" />
            <button onClick={() => void openWorkspace()} disabled={indexing}>{indexing ? "Indexing…" : "Open"}</button>
          </div>
          <div className="runtime">{health.runtime?.available ? "OpenCode ready" : "OpenCode not detected"}</div>
        </header>

        <div className="contentGrid">
          <section className="thread">
            {messages.length === 0 ? (
              <div className="hero"><div className="heroMark">B</div><h2>What are we building?</h2><p>Open a repository and BORG will index its instructions, docs, metadata, and relevant source before it starts changing code.</p></div>
            ) : (
              <div className="messages">
                {messages.map((message) => <article key={message.id} className={`message ${message.role}`}><span>{message.role === "user" ? "YOU" : "BORG"}</span><pre>{message.text}</pre></article>)}
                {approvals.map((approval) => <article key={approval.approvalId} className="approvalCard"><span>APPROVAL REQUIRED</span><strong>{approval.tool}</strong>{approval.reason && <p>{approval.reason}</p>}<pre>{JSON.stringify(approval.input, null, 2)}</pre><div><button onClick={() => void resolveApproval(approval.approvalId, false)}>Deny</button><button className="approve" onClick={() => void resolveApproval(approval.approvalId, true)}>Allow</button></div></article>)}
                {busy && approvals.length === 0 && <div className="thinking">BORG is working…</div>}
              </div>
            )}
          </section>

          <aside className="inspector">
            <div className="inspectorTabs">
              {(["diff", "terminal", "context"] as InspectorTab[]).map((tab) => <button key={tab} className={inspectorTab === tab ? "active" : ""} onClick={() => setInspectorTab(tab)}>{tab.toUpperCase()}</button>)}
            </div>
            {inspectorTab === "diff" && <div className="inspectorBody">
              <div className="panelToolbar"><strong>Working tree</strong><div><button onClick={() => void refreshDiff()} disabled={!workspaceRoot.trim()}>Refresh</button><button onClick={() => void undoLastChange()} disabled={!latestTaskId || undoing}>{undoing ? "Undoing…" : "Undo last"}</button></div></div>
              <pre className="statusBlock">{diffState.status || "Working tree clean"}</pre>
              <pre className="diffBlock">{diffState.diff || "No diff to review."}</pre>
            </div>}
            {inspectorTab === "terminal" && <div className="inspectorBody terminalBody"><div className="panelToolbar"><strong>Live tool output</strong><button onClick={() => setTerminal("")}>Clear</button></div><pre className="terminalBlock">{terminal || "Command and verification output will stream here."}</pre></div>}
            {inspectorTab === "context" && <div className="inspectorBody">
              <div className="panelToolbar"><strong>Repository context</strong><button onClick={() => void openWorkspace()} disabled={indexing}>Re-index</button></div>
              {workspaceSummary ? <>
                <div className="contextStats"><div><span>Files</span><strong>{workspaceSummary.fileCount}</strong></div><div><span>Instructions</span><strong>{workspaceSummary.instructionFiles.length}</strong></div><div><span>Docs</span><strong>{workspaceSummary.docFiles.length}</strong></div></div>
                <div className="contextSection"><span>Task-selected files</span>{contextFiles.length ? contextFiles.map((file) => <code key={file}>{file}</code>) : <p>Run a task to see the ranked context BORG selected.</p>}</div>
                <div className="contextSection"><span>Instructions discovered</span>{workspaceSummary.instructionFiles.length ? workspaceSummary.instructionFiles.map((file) => <code key={file}>{file}</code>) : <p>No AGENTS.md-style instruction files found.</p>}</div>
              </> : <p className="muted">Open a workspace to build its local index.</p>}
            </div>}
          </aside>
        </div>

        <form className="composer" onSubmit={submit}>
          <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Ask BORG to inspect, build, fix, or verify something…" rows={3} />
          <div className="composerBar">
            <div className="modes">
              {(["ask", "edit", "agent"] as PermissionMode[]).map((mode) => <button key={mode} type="button" className={permissionMode === mode ? "active" : ""} onClick={() => setPermissionMode(mode)}>{mode.toUpperCase()}</button>)}
            </div>
            <button className="send" disabled={busy || !prompt.trim()}>{busy ? "Running…" : "Run"}</button>
          </div>
        </form>
      </main>
    </div>
  );
}
