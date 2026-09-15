import { FormEvent, useEffect, useMemo, useState } from "react";

type PermissionMode = "ask" | "edit" | "agent";
type Message = { id: string; role: "user" | "assistant"; text: string };
type Health = { model?: { name: string; available: boolean }; runtime?: { id: string; available: boolean } };

type AgentEvent = { type: string; taskId: string; text?: string; error?: string };

const API = "http://127.0.0.1:8787";

export default function App() {
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("ask");
  const [health, setHealth] = useState<Health>({});
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [activeTask, setActiveTask] = useState<string | null>(null);
  const [streamed, setStreamed] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`${API}/api/health`).then((r) => r.json()).then(setHealth).catch(() => setHealth({}));
    const socket = new WebSocket("ws://127.0.0.1:8787/events");
    socket.onmessage = (message) => {
      const event = JSON.parse(message.data) as AgentEvent;
      if (event.taskId !== activeTask) return;
      if (event.type === "model.token" && event.text) setStreamed((value) => value + event.text);
    };
    return () => socket.close();
  }, [activeTask]);

  const status = useMemo(() => {
    if (!health.model) return "Server offline";
    return health.model.available ? `${health.model.name} online` : `${health.model.name} unavailable`;
  }, [health]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = prompt.trim();
    if (!value || busy) return;
    const taskId = crypto.randomUUID();
    setPrompt("");
    setBusy(true);
    setActiveTask(taskId);
    setStreamed("");
    setMessages((items) => [...items, { id: crypto.randomUUID(), role: "user", text: value }]);

    try {
      const response = await fetch(`${API}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId, prompt: value, permissionMode })
      });
      const body = await response.json() as { text?: string; error?: string };
      const text = body.text ?? body.error ?? "BORG returned no output.";
      setMessages((items) => [...items, { id: crypto.randomUUID(), role: "assistant", text }]);
      setStreamed("");
    } finally {
      setBusy(false);
      setActiveTask(null);
    }
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="mark">B</span><div><strong>BORG</strong><small>CODING</small></div></div>
        <button className="newTask">+ New task</button>
        <div className="sectionLabel">Workspace</div>
        <div className="repoCard"><span className="dot" /> No repository selected</div>
        <div className="sectionLabel">Tasks</div>
        <div className="empty">Task history will live here.</div>
        <div className="sidebarFooter"><span className={health.model?.available ? "status ok" : "status"} />{status}</div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div><h1>BORG Coding</h1><p>Local engineering agent</p></div>
          <div className="runtime">{health.runtime?.available ? "OpenCode ready" : "OpenCode not detected"}</div>
        </header>

        <section className="thread">
          {messages.length === 0 && !streamed ? (
            <div className="hero"><div className="heroMark">B</div><h2>What are we building?</h2><p>BORG can inspect a repository, implement changes, run commands, and verify the result locally.</p></div>
          ) : (
            <div className="messages">
              {messages.map((message) => <article key={message.id} className={`message ${message.role}`}><span>{message.role === "user" ? "YOU" : "BORG"}</span><pre>{message.text}</pre></article>)}
              {streamed && <article className="message assistant"><span>BORG</span><pre>{streamed}</pre></article>}
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
