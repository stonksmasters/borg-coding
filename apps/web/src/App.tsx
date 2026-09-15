import { FormEvent, useEffect, useMemo, useState } from "react";

type PermissionMode = "ask" | "edit" | "agent";
type Message = { id: string; role: "user" | "assistant"; text: string };
type Health = { model?: { name: string; available: boolean }; runtime?: { id: string; available: boolean } };
type Approval = { approvalId: string; taskId: string; tool: string; input: Record<string, unknown>; reason?: string };
type AgentEvent = { type: string; taskId: string; message?: string; text?: string; error?: string; approvalId?: string; approved?: boolean; tool?: string; input?: Record<string, unknown>; output?: unknown; reason?: string };

const API = "http://127.0.0.1:8787";

export default function App() {
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("ask");
  const [health, setHealth] = useState<Health>({});
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [activeTask, setActiveTask] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [activity, setActivity] = useState<string[]>([]);

  useEffect(() => {
    fetch(`${API}/api/health`).then((r) => r.json()).then(setHealth).catch(() => setHealth({}));
  }, []);

  useEffect(() => {
    if (!activeTask) return;
    const socket = new WebSocket("ws://127.0.0.1:8787/events");
    socket.onmessage = (message) => {
      const event = JSON.parse(message.data) as AgentEvent;
      if (event.taskId !== activeTask) return;
      if (event.type === "agent.status" && event.message) setActivity((items) => [...items, event.message!]);
      if (event.type === "tool.started" && event.tool) setActivity((items) => [...items, `Running ${event.tool}`]);
      if (event.type === "tool.completed" && event.tool) setActivity((items) => [...items, `${event.tool} completed`]);
      if (event.type === "approval.required" && event.approvalId && event.tool && event.input) {
        setApprovals((items) => [...items, { approvalId: event.approvalId!, taskId: event.taskId, tool: event.tool!, input: event.input!, reason: event.reason }]);
      }
      if (event.type === "approval.resolved" && event.approvalId) setApprovals((items) => items.filter((item) => item.approvalId !== event.approvalId));
    };
    return () => socket.close();
  }, [activeTask]);

  const status = useMemo(() => {
    if (!health.model) return "Server offline";
    return health.model.available ? `${health.model.name} online` : `${health.model.name} unavailable`;
  }, [health]);

  async function resolveApproval(approvalId: string, approved: boolean) {
    await fetch(`${API}/api/approvals/${encodeURIComponent(approvalId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approved })
    });
    setApprovals((items) => items.filter((item) => item.approvalId !== approvalId));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = prompt.trim();
    if (!value || busy) return;
    const taskId = crypto.randomUUID();
    setPrompt("");
    setBusy(true);
    setActiveTask(taskId);
    setApprovals([]);
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
    } finally {
      setBusy(false);
      setActiveTask(null);
      setApprovals([]);
    }
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="mark">B</span><div><strong>BORG</strong><small>CODING</small></div></div>
        <button className="newTask" onClick={() => { setMessages([]); setActivity([]); }}>+ New task</button>
        <div className="sectionLabel">Workspace</div>
        <div className="repoCard"><span className="dot" />{workspaceRoot || "Server working directory"}</div>
        <div className="sectionLabel">Activity</div>
        <div className="activityList">{activity.slice(-8).map((item, index) => <div key={`${item}-${index}`}>{item}</div>)}</div>
        <div className="sidebarFooter"><span className={health.model?.available ? "status ok" : "status"} />{status}</div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div><h1>BORG Coding</h1><p>Local engineering agent</p></div>
          <input className="workspaceInput" value={workspaceRoot} onChange={(event) => setWorkspaceRoot(event.target.value)} placeholder="Workspace root (optional)" />
          <div className="runtime">{health.runtime?.available ? "OpenCode ready" : "OpenCode not detected"}</div>
        </header>

        <section className="thread">
          {messages.length === 0 ? (
            <div className="hero"><div className="heroMark">B</div><h2>What are we building?</h2><p>BORG can inspect a repository, edit files, run commands, and verify the result locally.</p></div>
          ) : (
            <div className="messages">
              {messages.map((message) => <article key={message.id} className={`message ${message.role}`}><span>{message.role === "user" ? "YOU" : "BORG"}</span><pre>{message.text}</pre></article>)}
              {approvals.map((approval) => <article key={approval.approvalId} className="approvalCard"><span>APPROVAL REQUIRED</span><strong>{approval.tool}</strong>{approval.reason && <p>{approval.reason}</p>}<pre>{JSON.stringify(approval.input, null, 2)}</pre><div><button onClick={() => resolveApproval(approval.approvalId, false)}>Deny</button><button className="approve" onClick={() => resolveApproval(approval.approvalId, true)}>Allow</button></div></article>)}
              {busy && approvals.length === 0 && <div className="thinking">BORG is working…</div>}
            </div>
          )}
        </section>

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
