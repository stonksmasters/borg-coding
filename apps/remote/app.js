const els = {
  connectionDot: document.querySelector("#connectionDot"),
  connectionText: document.querySelector("#connectionText"),
  localSetup: document.querySelector("#localSetup"),
  pairCard: document.querySelector("#pairCard"),
  pairForm: document.querySelector("#pairForm"),
  pairCode: document.querySelector("#pairCode"),
  pairError: document.querySelector("#pairError"),
  app: document.querySelector("#app"),
  activeSessionTitle: document.querySelector("#activeSessionTitle"),
  refreshButton: document.querySelector("#refreshButton"),
  sessionList: document.querySelector("#sessionList"),
  taskState: document.querySelector("#taskState"),
  taskId: document.querySelector("#taskId"),
  workflowState: document.querySelector("#workflowState"),
  workflowNext: document.querySelector("#workflowNext"),
  sliceState: document.querySelector("#sliceState"),
  runtimeState: document.querySelector("#runtimeState"),
  diagnosticState: document.querySelector("#diagnosticState"),
  diagnosticDetail: document.querySelector("#diagnosticDetail"),
  approvalCard: document.querySelector("#approvalCard"),
  approvalTitle: document.querySelector("#approvalTitle"),
  approvalDetail: document.querySelector("#approvalDetail"),
  approveButton: document.querySelector("#approveButton"),
  rejectButton: document.querySelector("#rejectButton"),
  messages: document.querySelector("#messages"),
  messageCount: document.querySelector("#messageCount"),
  messageForm: document.querySelector("#messageForm"),
  messageInput: document.querySelector("#messageInput"),
  sendButton: document.querySelector("#sendButton"),
  stopButton: document.querySelector("#stopButton"),
  retryButton: document.querySelector("#retryButton"),
  activity: document.querySelector("#activity"),
  lastUpdated: document.querySelector("#lastUpdated"),
  logoutButton: document.querySelector("#logoutButton"),
};

const state = {
  sessions: [],
  activeSessionId: localStorage.getItem("borg.remote.session") || null,
  activeSession: null,
  taskId: null,
  task: null,
  workflow: null,
  debug: null,
  runtimeActive: false,
  refreshing: false,
  streamBusy: false,
};

function setConnection(kind, text) {
  els.connectionDot.classList.remove("live", "error");
  if (kind) els.connectionDot.classList.add(kind);
  els.connectionText.textContent = text;
}

function showPaired(paired) {
  els.pairCard.classList.toggle("hidden", paired);
  els.app.classList.toggle("hidden", !paired);
}

function human(value, fallback = "—") {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value).replaceAll("_", " ").toLowerCase().replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}

function shortId(value) {
  if (!value) return "No active task";
  const text = String(value);
  return text.length > 22 ? `${text.slice(0, 10)}…${text.slice(-8)}` : text;
}

function activityText(event) {
  if (!event || typeof event !== "object") return String(event ?? "");
  const type = String(event.type ?? event.kind ?? "event");
  const message = event.message ?? event.summary ?? event.detail ?? event.title;
  return message ? `${type}: ${message}` : type;
}

function addTransientActivity(text, error = false) {
  const item = document.createElement("div");
  item.className = `activity-item${error ? " error" : ""}`;
  item.textContent = text;
  els.activity.prepend(item);
  while (els.activity.childElementCount > 20) els.activity.lastElementChild?.remove();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  if (response.status === 401) {
    showPaired(false);
    setConnection("error", "Pairing required");
  }
  return response;
}

async function loadLocalSetup() {
  try {
    const response = await fetch("/api/local-info", { cache: "no-store" });
    if (!response.ok) return;
    const info = await response.json();
    els.localSetup.replaceChildren();
    const eyebrow = document.createElement("p");
    eyebrow.className = "eyebrow";
    eyebrow.textContent = "LOCAL SETUP";
    const title = document.createElement("h2");
    title.textContent = "Pair your phone";
    const detail = document.createElement("p");
    detail.className = "muted";
    detail.textContent = "On your phone, open one of these addresses while both devices are on the same Wi-Fi, then enter this code:";
    const code = document.createElement("div");
    code.className = "setup-code";
    code.textContent = info.pairingCode || "------";
    els.localSetup.append(eyebrow, title, detail, code);
    for (const url of info.urls || []) {
      const line = document.createElement("div");
      line.className = "setup-url mono subtle";
      line.textContent = url;
      els.localSetup.append(line);
    }
    if (!(info.urls || []).length) {
      const line = document.createElement("div");
      line.className = "setup-url subtle";
      line.textContent = "No LAN IPv4 address was detected.";
      els.localSetup.append(line);
    }
    els.localSetup.classList.remove("hidden");
  } catch {
    // Remote phones intentionally cannot read the pairing code.
  }
}

function chooseDefaultSession() {
  if (!state.sessions.length) {
    state.activeSessionId = null;
    state.activeSession = null;
    return;
  }
  const exists = state.sessions.some((session) => session.id === state.activeSessionId);
  if (!exists) {
    const primary = state.sessions.find((session) => !session.parentSessionId) || state.sessions[0];
    state.activeSessionId = primary.id;
  }
  localStorage.setItem("borg.remote.session", state.activeSessionId);
}

function renderSessions() {
  els.sessionList.replaceChildren();
  for (const session of state.sessions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `session-chip${session.id === state.activeSessionId ? " active" : ""}`;
    button.textContent = session.title || "Untitled session";
    button.addEventListener("click", () => {
      state.activeSessionId = session.id;
      localStorage.setItem("borg.remote.session", session.id);
      renderSessions();
      void refreshActive();
    });
    els.sessionList.append(button);
  }
}

function renderMessages(messages = []) {
  els.messages.replaceChildren();
  const visible = messages.slice(-40);
  for (const message of visible) {
    const item = document.createElement("div");
    item.className = `message ${String(message.role || "system").toLowerCase()}`;
    const role = document.createElement("span");
    role.className = "message-role";
    role.textContent = message.kind ? `${message.role || "system"} · ${message.kind}` : message.role || "system";
    const body = document.createElement("span");
    body.textContent = message.text || "";
    item.append(role, body);
    els.messages.append(item);
  }
  els.messageCount.textContent = String(messages.length);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function renderActivity(snapshot) {
  els.activity.replaceChildren();
  const diagnostics = Array.isArray(snapshot?.diagnostics) ? snapshot.diagnostics : [];
  const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
  const records = [
    ...diagnostics.slice(0, 6).map((item) => ({
      text: `${item.severity || "info"} · ${item.title || item.id}: ${item.evidence || item.detail || ""}`,
      error: item.severity === "error",
    })),
    ...events.slice(-12).reverse().map((event) => ({ text: activityText(event), error: false })),
  ].slice(0, 18);
  if (!records.length) {
    const empty = document.createElement("div");
    empty.className = "activity-item";
    empty.textContent = "No control-plane activity yet.";
    els.activity.append(empty);
    return;
  }
  for (const record of records) addTransientActivity(record.text, record.error);
}

function renderState(runtime) {
  const session = runtime?.session || state.sessions.find((candidate) => candidate.id === state.activeSessionId) || null;
  state.activeSession = session;
  state.taskId = runtime?.latestTaskId || null;
  state.task = runtime?.task || null;
  state.runtimeActive = Boolean(runtime?.runtimeActive);
  els.activeSessionTitle.textContent = session?.title || "Choose a session";
  els.taskState.textContent = human(state.task?.state, state.runtimeActive ? "Running" : "Idle");
  els.taskId.textContent = shortId(state.taskId);
  els.runtimeState.textContent = state.runtimeActive ? "Runtime active" : "Runtime idle";
  els.stopButton.disabled = !state.runtimeActive || state.streamBusy;
  els.sendButton.disabled = !session || state.runtimeActive || state.streamBusy;
  els.messageInput.disabled = !session || state.runtimeActive || state.streamBusy;
  renderMessages(runtime?.messages || []);

  const approval = runtime?.approval;
  const pending = state.task?.state === "AWAITING_APPROVAL" && approval?.status === "REQUESTED";
  els.approvalCard.classList.toggle("hidden", !pending);
  if (pending) {
    els.approvalTitle.textContent = runtime?.projectPlanApproval ? "Approve frontend plan" : "BORG needs approval";
    els.approvalDetail.textContent = runtime?.escalation?.planText
      ? "PLAN is complete. Approval authorizes the persisted work."
      : "Review the plan on desktop if needed, then approve or reject from here.";
  }

  const retryable = ["BLOCKED", "FAILED", "RECOVERY_REQUIRED"].includes(state.task?.state || "");
  els.retryButton.classList.toggle("hidden", !retryable);
}

function renderWorkflow(payload) {
  const workflow = payload?.workflow || payload?.status || payload || null;
  state.workflow = workflow;
  els.workflowState.textContent = human(workflow?.status ?? workflow?.phase, "—");
  els.workflowNext.textContent = workflow?.nextAction ? `Next: ${human(workflow.nextAction)}` : "No next action";
  const index = Number(workflow?.sliceIndex);
  const total = Number(workflow?.sliceTotal);
  els.sliceState.textContent = Number.isFinite(index) && Number.isFinite(total) && total > 0
    ? `${index + 1} / ${total}`
    : human(workflow?.sliceTitle, "—");
}

function renderDebug(payload) {
  const snapshot = payload?.snapshot || null;
  state.debug = snapshot;
  const diagnostics = Array.isArray(snapshot?.diagnostics) ? snapshot.diagnostics : [];
  const errors = diagnostics.filter((item) => item.severity === "error").length;
  const warnings = diagnostics.filter((item) => item.severity === "warning").length;
  els.diagnosticState.textContent = errors ? `${errors} error${errors === 1 ? "" : "s"}` : warnings ? `${warnings} warning${warnings === 1 ? "" : "s"}` : "Healthy";
  els.diagnosticDetail.textContent = diagnostics[0]?.title || "No invariant violations";
  renderActivity(snapshot);
}

async function refreshSessions() {
  const response = await api("/api/remote/sessions");
  if (!response.ok) {
    if (response.status !== 401) setConnection("error", "BORG unavailable");
    return false;
  }
  const body = await response.json();
  state.sessions = Array.isArray(body.sessions) ? body.sessions : [];
  chooseDefaultSession();
  renderSessions();
  showPaired(true);
  setConnection("live", "Connected");
  return true;
}

async function refreshActive() {
  if (state.refreshing || !state.activeSessionId) return;
  state.refreshing = true;
  try {
    const response = await api(`/api/remote/sessions/${encodeURIComponent(state.activeSessionId)}`);
    if (!response.ok) return;
    const runtime = await response.json();
    renderState(runtime);
    if (state.taskId) {
      const [workflowResponse, debugResponse] = await Promise.all([
        api(`/api/remote/tasks/${encodeURIComponent(state.taskId)}/workflow-status`),
        api(`/api/remote/tasks/${encodeURIComponent(state.taskId)}/debug`),
      ]);
      if (workflowResponse.ok) renderWorkflow(await workflowResponse.json());
      else renderWorkflow(null);
      if (debugResponse.ok) renderDebug(await debugResponse.json());
      else renderDebug(null);
    } else {
      renderWorkflow(null);
      renderDebug(null);
    }
    els.lastUpdated.textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
    setConnection("live", "Connected");
  } catch (error) {
    setConnection("error", "Connection lost");
    addTransientActivity(error instanceof Error ? error.message : "Refresh failed", true);
  } finally {
    state.refreshing = false;
  }
}

async function consumeNdjson(response) {
  if (!response.body) {
    const text = await response.text().catch(() => "");
    if (!response.ok) throw new Error(text || `Request failed (${response.status})`);
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        addTransientActivity(activityText(event), event.type === "runtime.failed" || event.type === "tool.failed");
      } catch {
        addTransientActivity(line);
      }
    }
    if (done) break;
  }
  if (buffer.trim()) addTransientActivity(buffer.trim());
}

async function decideApproval(decision) {
  if (!state.taskId) return;
  els.approveButton.disabled = true;
  els.rejectButton.disabled = true;
  try {
    const response = await api(`/api/remote/tasks/${encodeURIComponent(state.taskId)}/approval`, {
      method: "POST",
      body: JSON.stringify({ decision }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Approval failed (${response.status})`);
    addTransientActivity(decision === "approve" ? "Approval granted." : "Approval rejected.");
    await refreshActive();
  } catch (error) {
    addTransientActivity(error instanceof Error ? error.message : "Approval failed", true);
  } finally {
    els.approveButton.disabled = false;
    els.rejectButton.disabled = false;
  }
}

async function stopSession() {
  if (!state.activeSessionId || !state.runtimeActive) return;
  els.stopButton.disabled = true;
  try {
    const response = await api(`/api/remote/sessions/${encodeURIComponent(state.activeSessionId)}/stop`, { method: "POST" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Stop failed (${response.status})`);
    addTransientActivity(body.stopped ? "Stop requested for the active runtime." : "No active runtime was found.");
    await refreshActive();
  } catch (error) {
    addTransientActivity(error instanceof Error ? error.message : "Stop failed", true);
  }
}

async function retryTask() {
  if (!state.taskId || state.streamBusy) return;
  state.streamBusy = true;
  renderState({ session: state.activeSession, latestTaskId: state.taskId, task: state.task, runtimeActive: true, messages: [] });
  try {
    const response = await api(`/api/remote/tasks/${encodeURIComponent(state.taskId)}/retry`, { method: "POST" });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Retry failed (${response.status})`);
    }
    await consumeNdjson(response);
  } catch (error) {
    addTransientActivity(error instanceof Error ? error.message : "Retry failed", true);
  } finally {
    state.streamBusy = false;
    await refreshActive();
  }
}

els.pairForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  els.pairError.textContent = "";
  const code = els.pairCode.value.trim();
  try {
    const response = await fetch("/api/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Unable to pair this device.");
    els.pairCode.value = "";
    if (await refreshSessions()) await refreshActive();
  } catch (error) {
    els.pairError.textContent = error instanceof Error ? error.message : "Unable to pair this device.";
  }
});

els.messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.activeSessionId || state.streamBusy) return;
  const request = els.messageInput.value.trim();
  if (!request) return;
  state.streamBusy = true;
  els.sendButton.disabled = true;
  els.stopButton.disabled = false;
  els.messageInput.disabled = true;
  addTransientActivity("Message sent to BORG.");
  try {
    const response = await api("/api/remote/chat", {
      method: "POST",
      body: JSON.stringify({ sessionId: state.activeSessionId, request }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Chat failed (${response.status})`);
    }
    els.messageInput.value = "";
    await consumeNdjson(response);
  } catch (error) {
    addTransientActivity(error instanceof Error ? error.message : "Chat failed", true);
  } finally {
    state.streamBusy = false;
    await refreshActive();
  }
});

els.approveButton.addEventListener("click", () => void decideApproval("approve"));
els.rejectButton.addEventListener("click", () => void decideApproval("reject"));
els.stopButton.addEventListener("click", () => void stopSession());
els.retryButton.addEventListener("click", () => void retryTask());
els.refreshButton.addEventListener("click", async () => {
  if (await refreshSessions()) await refreshActive();
});
els.logoutButton.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" }).catch(() => undefined);
  state.sessions = [];
  state.activeSessionId = null;
  localStorage.removeItem("borg.remote.session");
  showPaired(false);
  setConnection("", "Unpaired");
});

void loadLocalSetup();
void (async () => {
  if (await refreshSessions()) await refreshActive();
})();

setInterval(() => {
  if (!document.hidden && !state.streamBusy) void refreshActive();
}, 2500);
setInterval(() => {
  if (!document.hidden && !state.streamBusy) void refreshSessions();
}, 15000);

if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("/sw.js").catch(() => undefined);
}
