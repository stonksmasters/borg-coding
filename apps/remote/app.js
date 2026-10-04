const els = {
  connectionDot: document.querySelector("#connectionDot"),
  connectionText: document.querySelector("#connectionText"),
  localSetup: document.querySelector("#localSetup"),
  pairCard: document.querySelector("#pairCard"),
  pairForm: document.querySelector("#pairForm"),
  pairCode: document.querySelector("#pairCode"),
  pairError: document.querySelector("#pairError"),
  commandStatus: document.querySelector("#commandStatus"),
  commandState: document.querySelector("#commandState"),
  commandMessage: document.querySelector("#commandMessage"),
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
  sliceTitle: document.querySelector("#sliceTitle"),
  sliceProgress: document.querySelector("#sliceProgress"),
  objective: document.querySelector("#objective"),
  currentAction: document.querySelector("#currentAction"),
  nextAction: document.querySelector("#nextAction"),
  verificationState: document.querySelector("#verificationState"),
  visualState: document.querySelector("#visualState"),
  blockerCard: document.querySelector("#blockerCard"),
  blockerTitle: document.querySelector("#blockerTitle"),
  blockerDetail: document.querySelector("#blockerDetail"),
  blockerAction: document.querySelector("#blockerAction"),
  planPhase: document.querySelector("#planPhase"),
  stageChecklist: document.querySelector("#stageChecklist"),
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
  workspaceTabs: document.querySelector("#workspaceTabs"),
  previewMessage: document.querySelector("#previewMessage"),
  openPreviewLink: document.querySelector("#openPreviewLink"),
  previewFrameShell: document.querySelector("#previewFrameShell"),
  previewFrame: document.querySelector("#previewFrame"),
  refreshPreviewButton: document.querySelector("#refreshPreviewButton"),
  blueprintContent: document.querySelector("#blueprintContent"),
  projectContent: document.querySelector("#projectContent"),
  reviewContent: document.querySelector("#reviewContent"),
  debugContent: document.querySelector("#debugContent"),
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
  actions: {},
  activeTab: localStorage.getItem("borg.remote.tab") || "overview",
  blueprint: null,
  previewUrl: null,
};

function textNode(tag, text, className = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text ?? "";
  return element;
}

function labeledValue(label, value) {
  const item = document.createElement("div");
  item.className = "info-item";
  item.append(textNode("span", label, "label"), textNode("div", value || "—", "info-value"));
  return item;
}

function renderObject(container, value, empty = "No information available.") {
  container.replaceChildren();
  if (!value || (Array.isArray(value) && !value.length)) return container.append(textNode("p", empty, "muted"));
  const pre = textNode("pre", JSON.stringify(value, null, 2), "data-block");
  container.append(pre);
}

function setTab(tab) {
  state.activeTab = tab;
  localStorage.setItem("borg.remote.tab", tab);
  for (const button of els.workspaceTabs.querySelectorAll("button")) button.classList.toggle("active", button.dataset.tab === tab);
  for (const panel of document.querySelectorAll(".workspace-panel")) panel.classList.toggle("hidden", panel.dataset.panel !== tab);
  if (tab === "preview") void loadPreview();
  if (["blueprint", "project", "review", "debug"].includes(tab)) void loadWorkspaceTab(tab);
}

function setCommandState(action, phase, message) {
  state.actions[action] = phase;
  els.commandStatus.dataset.state = phase;
  els.commandState.textContent = human(phase);
  els.commandMessage.textContent = message;
}

function actionPending(action) {
  return state.actions[action] === "sending";
}

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
      state.previewUrl = null;
      els.previewFrame.removeAttribute("src");
      state.activeSessionId = session.id;
      localStorage.setItem("borg.remote.session", session.id);
      setCommandState("session", "accepted", `Selected ${session.title || "session"}.`);
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
  els.stopButton.disabled = !state.runtimeActive || actionPending("stop");
  els.sendButton.disabled = !session || actionPending("instruction");
  els.messageInput.disabled = !session;
  els.sendButton.textContent = state.runtimeActive || state.streamBusy ? "Queue instruction" : "Send";
  renderMessages(runtime?.messages || []);

  const approval = runtime?.approval;
  const pending = state.task?.state === "AWAITING_APPROVAL" && approval?.status === "REQUESTED";
  els.approvalCard.classList.toggle("hidden", !pending);
  if (pending) {
    els.approvalTitle.textContent = runtime?.projectPlanRevisionApproval
      ? "Approve plan revision & continue"
      : runtime?.projectPlanApproval
        ? "Approve frontend plan"
        : "BORG needs approval";
    els.approvalDetail.textContent = runtime?.projectPlanRevisionApproval
      ? "BORG revised the project plan because the current slice could not legally satisfy product-quality review. Approval resumes the existing worktree."
      : runtime?.escalation?.planText
        ? "PLAN is complete. Approval authorizes the persisted work."
        : "Review the plan on desktop if needed, then approve or reject from here.";
  }

  const retryable = ["BLOCKED", "FAILED", "RECOVERY_REQUIRED"].includes(state.task?.state || "");
  els.retryButton.classList.toggle("hidden", !retryable);
  els.retryButton.disabled = !retryable || actionPending("retry");
  els.approveButton.disabled = !pending || actionPending("approval");
  els.rejectButton.disabled = !pending || actionPending("approval");
}

function renderWorkflow(payload) {
  const workflow = payload?.workflow || payload?.status || payload || null;
  state.workflow = workflow;
  state.blueprint = payload?.blueprint || null;
  els.workflowState.textContent = human(workflow?.status ?? workflow?.phase, "—");
  els.workflowNext.textContent = workflow?.nextAction ? `Next: ${human(workflow.nextAction)}` : "No next action";
  const index = Number(workflow?.sliceIndex);
  const total = Number(workflow?.sliceTotal);
  els.sliceState.textContent = Number.isFinite(index) && Number.isFinite(total) && total > 0
    ? `${index + 1} / ${total}`
    : human(workflow?.sliceTitle, "—");

  const run = workflow?.run || {};
  const slice = run.slice || {};
  const blocker = run.blocker || workflow?.recovery || null;
  const verification = run.verification || {};
  els.sliceTitle.textContent = slice.title || workflow?.sliceTitle || "No active slice";
  els.sliceProgress.textContent = Number.isFinite(index) && Number.isFinite(total) && total > 0 ? `Slice ${index + 1} of ${total}` : "—";
  els.objective.textContent = slice.outcome || workflow?.objective || workflow?.detail || "No objective has been recorded.";
  els.currentAction.textContent = human(run.currentAction || workflow?.currentAction, "Idle");
  els.nextAction.textContent = human(run.nextAction || workflow?.nextAction, "No next action");
  els.verificationState.textContent = human(verification.status ?? workflow?.verificationPassed, "Pending");
  els.visualState.textContent = human(verification.visualStatus, "Pending");
  els.planPhase.textContent = human(workflow?.phase, "—");
  els.blockerCard.classList.toggle("hidden", !blocker);
  if (blocker) {
    els.blockerTitle.textContent = blocker.title || human(blocker.category, "Recovery required");
    els.blockerDetail.textContent = blocker.detail || blocker.reason || workflow?.detail || "BORG needs attention before it can continue.";
    const action = blocker.action || blocker.resumeAction || workflow?.nextAction;
    els.blockerAction.textContent = action ? `Next step: ${human(action)}` : "";
  }
  const completed = new Set(Array.isArray(workflow?.completed) ? workflow.completed : []);
  const pending = new Set(Array.isArray(workflow?.pending) ? workflow.pending : []);
  const stages = [["Plan", "PLAN_COMPLETED"], ["Implement", "IMPLEMENTATION_RESPONSE_COMPLETED"], ["Verify", "VERIFICATION_COMPLETED"], ["Review", "REVIEW_COMPLETED"], ["Deliver", "DELIVERY_READY"]];
  els.stageChecklist.replaceChildren();
  for (const [label, key] of stages) {
    const item = document.createElement("div");
    const done = completed.has(key);
    const waiting = pending.has(key);
    item.className = `stage-item ${done ? "done" : waiting ? "pending" : "idle"}`;
    const marker = document.createElement("span"); marker.className = "stage-marker"; marker.textContent = done ? "✓" : waiting ? "•" : "–";
    const text = document.createElement("span"); text.textContent = label;
    item.append(marker, text); els.stageChecklist.append(item);
  }
  renderBlueprint();
}

function renderBlueprint() {
  const blueprint = state.blueprint;
  els.blueprintContent.replaceChildren();
  if (!blueprint) return els.blueprintContent.append(textNode("p", "No durable product blueprint is available for this task.", "muted"));
  const header = document.createElement("div"); header.className = "info-grid";
  header.append(
    labeledValue("Product", blueprint.productName || blueprint.title || "Website"),
    labeledValue("Goal", blueprint.productGoal || blueprint.goal || blueprint.objective),
    labeledValue("Audience", Array.isArray(blueprint.targetAudience) ? blueprint.targetAudience.join(", ") : blueprint.targetAudience),
    labeledValue("Direction", blueprint.visualDirection || blueprint.designDirection),
  );
  els.blueprintContent.append(header);
  const slices = blueprint.slices || blueprint.implementationSlices || blueprint.phases;
  if (Array.isArray(slices) && slices.length) {
    els.blueprintContent.append(textNode("h3", "Implementation slices"));
    const list = document.createElement("div"); list.className = "stack-list";
    slices.forEach((slice, index) => {
      const item = document.createElement("article"); item.className = "stack-item";
      item.append(textNode("strong", `${index + 1}. ${slice.title || slice.name || "Untitled slice"}`));
      item.append(textNode("p", slice.outcome || slice.objective || slice.description || "", "muted"));
      list.append(item);
    });
    els.blueprintContent.append(list);
  }
  const details = document.createElement("details"); details.append(textNode("summary", "Full blueprint data"), textNode("pre", JSON.stringify(blueprint, null, 2), "data-block"));
  els.blueprintContent.append(details);
}

async function loadPreview(force = false) {
  if (!state.activeSessionId) return;
  if (state.previewUrl && !force) return;
  els.previewMessage.textContent = "Starting the task preview…";
  els.refreshPreviewButton.disabled = true;
  try {
    const response = await api(`/api/remote/sessions/${encodeURIComponent(state.activeSessionId)}/preview`, { method: "POST" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.preview?.url) throw new Error(body.error || "No website preview is available for this session.");
    state.previewUrl = body.preview.url;
    els.previewFrame.src = `${state.previewUrl}?borgRemote=${Date.now()}`;
    els.openPreviewLink.href = state.previewUrl;
    els.openPreviewLink.classList.remove("hidden");
    els.previewFrameShell.classList.remove("hidden");
    els.previewMessage.textContent = "Live preview from the active task worktree.";
  } catch (error) {
    state.previewUrl = null;
    els.previewFrameShell.classList.add("hidden");
    els.openPreviewLink.classList.add("hidden");
    els.previewMessage.textContent = error instanceof Error ? error.message : "Preview unavailable.";
  } finally { els.refreshPreviewButton.disabled = false; }
}

async function loadWorkspaceTab(tab) {
  if (!state.taskId) return;
  const id = encodeURIComponent(state.taskId);
  try {
    if (tab === "blueprint") { renderBlueprint(); return; }
    if (tab === "project") {
      const [project, docs, contexts] = await Promise.all(["project", "docs", "contexts"].map(async (resource) => { const response = await api(`/api/remote/tasks/${id}/${resource}`); return response.ok ? response.json() : null; }));
      els.projectContent.replaceChildren();
      const entries = project?.entries || project?.tree || [];
      els.projectContent.append(textNode("h3", "Files"));
      if (Array.isArray(entries) && entries.length) {
        const list = document.createElement("div"); list.className = "file-list";
        for (const entry of entries.slice(0, 300)) list.append(textNode("div", `${entry.type === "directory" ? "▸" : "·"} ${entry.path || entry.name}`, "file-row mono"));
        els.projectContent.append(list);
      } else els.projectContent.append(textNode("p", "No project files returned.", "muted"));
      els.projectContent.append(textNode("h3", "Build documents"));
      const docList = document.createElement("div"); docList.className = "stack-list";
      for (const doc of docs?.docs || []) { const item = document.createElement("details"); item.className = "stack-item"; item.append(textNode("summary", doc.title || doc.path || "Document"), textNode("pre", doc.content || doc.text || JSON.stringify(doc, null, 2), "data-block")); docList.append(item); }
      els.projectContent.append(docList, textNode("h3", `Model context (${contexts?.contexts?.length || 0})`));
      for (const context of contexts?.contexts || []) els.projectContent.append(labeledValue(context.role || "Context", `${context.model || "model"} · ${new Date(context.createdAt).toLocaleString()}`));
    }
    if (tab === "review") {
      const resources = ["changes", "design", "activity", "processes", "review-history"];
      const data = await Promise.all(resources.map(async (resource) => { const response = await api(`/api/remote/tasks/${id}/${resource}`); return response.ok ? response.json() : null; }));
      const [changes, design, activity, processes, history] = data;
      els.reviewContent.replaceChildren();
      els.reviewContent.append(textNode("h3", `Changes · ${changes?.files?.length || 0} files`));
      els.reviewContent.append(labeledValue("Diff summary", `+${changes?.additions || 0} / -${changes?.deletions || 0}`));
      for (const file of changes?.files || []) { const details = document.createElement("details"); details.className = "stack-item"; details.append(textNode("summary", `${human(file.status)} · ${file.path} (+${file.additions}/-${file.deletions})`), textNode("pre", file.patch || "No textual patch.", "data-block diff-block")); els.reviewContent.append(details); }
      els.reviewContent.append(textNode("h3", "Design review"));
      els.reviewContent.append(labeledValue("Status", design?.review?.status || "Not completed"), labeledValue("Summary", design?.review?.summary || "No design review summary."));
      for (const finding of design?.review?.findings || []) els.reviewContent.append(labeledValue(`${human(finding.severity)} · ${finding.title || finding.dimension}`, finding.description || finding.evidence));
      els.reviewContent.append(textNode("h3", `Review history · ${history?.findings?.length || 0} findings`));
      for (const finding of history?.findings || []) els.reviewContent.append(labeledValue(`${human(finding.state)} · ${finding.title}`, finding.description || finding.evidence));
      els.reviewContent.append(textNode("h3", "Activity and processes"));
      for (const item of activity?.activities || []) els.reviewContent.append(labeledValue(item.title || human(item.phase), item.detail));
      for (const process of processes?.processes || []) els.reviewContent.append(labeledValue(`${process.label} · ${human(process.status)}`, process.stderr || process.stdout || `${process.command || ""} ${(process.args || []).join(" ")}`));
    }
    if (tab === "debug") renderDebugContent(state.debug);
  } catch (error) {
    const target = tab === "project" ? els.projectContent : tab === "review" ? els.reviewContent : els.debugContent;
    target.replaceChildren(textNode("p", error instanceof Error ? error.message : "Unable to load this panel.", "error"));
  }
}

function renderDebugContent(snapshot) {
  els.debugContent.replaceChildren();
  if (!snapshot) return els.debugContent.append(textNode("p", "No debug snapshot is available.", "muted"));
  const grid = document.createElement("div"); grid.className = "info-grid";
  grid.append(labeledValue("Task", `${snapshot.task?.state || "—"} · attempt ${snapshot.task?.attempts ?? 0}`), labeledValue("Workflow", `${snapshot.workflow?.phase || "—"} · ${snapshot.workflow?.status || "—"}`), labeledValue("Next action", snapshot.workflow?.nextAction), labeledValue("Git", snapshot.git?.status || "Clean"));
  els.debugContent.append(grid, textNode("h3", "Diagnostics"));
  for (const item of snapshot.diagnostics || []) els.debugContent.append(labeledValue(`${human(item.severity)} · ${item.title}`, `${item.detail || item.evidence || ""}${item.suggestedAction ? ` Next: ${item.suggestedAction}` : ""}`));
  els.debugContent.append(textNode("h3", `Models and context · ${snapshot.modelContexts?.length || 0}`));
  for (const item of snapshot.modelContexts || []) els.debugContent.append(labeledValue(item.role, `${item.model} · ${item.manifestCount} context items`));
  const details = document.createElement("details"); details.append(textNode("summary", "Raw sanitized snapshot"), textNode("pre", JSON.stringify(snapshot, null, 2), "data-block")); els.debugContent.append(details);
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
  renderDebugContent(snapshot);
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
    if (state.activeSession?.id !== runtime?.session?.id) state.previewUrl = null;
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
  let failure = null;
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
        if (["runtime.failed", "stream.failed", "tool.failed"].includes(event.type)) failure = event.message || "BORG rejected the command.";
      } catch {
        addTransientActivity(line);
      }
    }
    if (done) break;
  }
  if (buffer.trim()) addTransientActivity(buffer.trim());
  if (failure) throw new Error(failure);
}

async function decideApproval(decision) {
  if (!state.taskId) return;
  setCommandState("approval", "sending", decision === "approve" ? "Sending approval…" : "Sending rejection…");
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
    setCommandState("approval", "accepted", decision === "approve" ? "Approval accepted." : "Rejection accepted.");
    await refreshActive();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Approval failed";
    setCommandState("approval", "failed", message);
    addTransientActivity(message, true);
  } finally {
    els.approveButton.disabled = false;
    els.rejectButton.disabled = false;
  }
}

async function stopSession() {
  if (!state.activeSessionId || !state.runtimeActive) return;
  setCommandState("stop", "sending", "Sending stop request…");
  els.stopButton.disabled = true;
  try {
    const response = await api(`/api/remote/sessions/${encodeURIComponent(state.activeSessionId)}/stop`, { method: "POST" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Stop failed (${response.status})`);
    addTransientActivity(body.stopped ? "Stop requested for the active runtime." : "No active runtime was found.");
    setCommandState("stop", "accepted", body.stopped ? "Stop accepted." : "Runtime was already idle.");
    await refreshActive();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Stop failed";
    setCommandState("stop", "failed", message);
    addTransientActivity(message, true);
  } finally {
    els.stopButton.disabled = !state.runtimeActive;
  }
}

async function retryTask() {
  if (!state.taskId || state.streamBusy) return;
  state.streamBusy = true;
  setCommandState("retry", "sending", "Retrying the blocked task…");
  renderState({ session: state.activeSession, latestTaskId: state.taskId, task: state.task, runtimeActive: true, messages: [] });
  try {
    const response = await api(`/api/remote/tasks/${encodeURIComponent(state.taskId)}/retry`, { method: "POST" });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Retry failed (${response.status})`);
    }
    await consumeNdjson(response);
    setCommandState("retry", "accepted", "Retry accepted.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Retry failed";
    setCommandState("retry", "failed", message);
    addTransientActivity(message, true);
  } finally {
    state.streamBusy = false;
    await refreshActive();
  }
}

els.pairForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  els.pairError.textContent = "";
  const code = els.pairCode.value.trim();
  setCommandState("pair", "sending", "Pairing with BORG…");
  try {
    const response = await fetch("/api/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Unable to pair this device.");
    els.pairCode.value = "";
    setCommandState("pair", "accepted", "Device paired.");
    if (await refreshSessions()) await refreshActive();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to pair this device.";
    els.pairError.textContent = message;
    setCommandState("pair", "failed", message);
  }
});

els.messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.activeSessionId) return;
  const request = els.messageInput.value.trim();
  if (!request) return;
  if (state.runtimeActive || state.streamBusy) {
    setCommandState("instruction", "sending", "Queueing instruction…");
    els.sendButton.disabled = true;
    try {
      const response = await api("/api/remote/instructions", {
        method: "POST",
        body: JSON.stringify({ sessionId: state.activeSessionId, text: request }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Instruction failed (${response.status})`);
      els.messageInput.value = "";
      addTransientActivity(body.message || "Instruction queued.");
      setCommandState("instruction", "accepted", body.message || "Instruction queued.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Instruction failed";
      setCommandState("instruction", "failed", message);
      addTransientActivity(message, true);
    } finally {
      els.sendButton.disabled = false;
    }
    return;
  }
  state.streamBusy = true;
  setCommandState("chat", "sending", "Message sent. Waiting for BORG…");
  els.stopButton.disabled = false;
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
    setCommandState("chat", "accepted", "Response received.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Chat failed";
    setCommandState("chat", "failed", message);
    addTransientActivity(message, true);
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
  setCommandState("refresh", "sending", "Refreshing remote state…");
  try {
    if (!await refreshSessions()) throw new Error("Desktop gateway unavailable.");
    await refreshActive();
    setCommandState("refresh", "accepted", "Remote state refreshed.");
  } catch (error) {
    setCommandState("refresh", "failed", error instanceof Error ? error.message : "Refresh failed.");
  }
});
els.workspaceTabs.addEventListener("click", (event) => { const button = event.target.closest("button[data-tab]"); if (button) setTab(button.dataset.tab); });
els.refreshPreviewButton.addEventListener("click", () => void loadPreview(true));
els.logoutButton.addEventListener("click", async () => {
  setCommandState("logout", "sending", "Unpairing this device…");
  await fetch("/api/logout", { method: "POST" }).catch(() => undefined);
  state.sessions = [];
  state.activeSessionId = null;
  localStorage.removeItem("borg.remote.session");
  showPaired(false);
  setConnection("", "Unpaired");
  setCommandState("logout", "accepted", "Device unpaired.");
});

void loadLocalSetup();
setTab(state.activeTab);
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
