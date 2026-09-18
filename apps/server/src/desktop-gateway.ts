import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  createChatMessage,
  createChatSession,
  createModeEscalationRequest,
  permissionModes,
  type ChatMessage,
  type ChatSession,
  type PermissionMode,
} from "../../../packages/core/src/chat-session.ts";
import { SqliteChatRepository } from "../../../packages/persistence/src/sqlite-chat-repository.ts";
import { AccessController } from "../../../packages/repository/src/access-controller.ts";
import { DesktopCredentialStore } from "../../../packages/tools/src/credential-store.ts";
import { InternetConfigurationStore } from "../../../packages/tools/src/internet-configuration.ts";
import { createWebsiteProject, websiteInfo, websiteTemplates, WebsitePreviewManager, type WebsiteTemplate } from "../../../packages/web-builder/src/project-bootstrap.ts";
import { readProjectPlan, readSliceState, type ProjectPlan } from "../../../packages/web-builder/src/slice-docs.ts";

const gatewayPort = Number(process.env.BORG_GATEWAY_PORT ?? 4312);
const coreUrl = process.env.BORG_CORE_URL ?? "http://127.0.0.1:4311";
const databasePath = resolve(process.env.BORG_DATABASE_PATH ?? ".borg/borg.db");
mkdirSync(dirname(databasePath), { recursive: true });

const chats = new SqliteChatRepository(databasePath);
const access = new AccessController(resolve(".borg/access.json"));
const credentials = new DesktopCredentialStore();
const internet = new InternetConfigurationStore(resolve(".borg/internet.json"), credentials);
const activeStreams = new Map<string, AbortController>();
const frontendLaunches = new Map<string, { session: ChatSession; run: Promise<void> }>();
const previews = new WebsitePreviewManager();
type EventSink = (event: Record<string, unknown>) => void;

function headers(contentType = "application/json") {
  return {
    "content-type": contentType,
    "access-control-allow-origin": "http://localhost:5173",
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, headers());
  response.end(JSON.stringify(body));
}

function writeEvent(response: ServerResponse, event: Record<string, unknown>) {
  response.write(`${JSON.stringify(event)}\n`);
}

function readText(request: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => resolveBody(body));
    request.on("error", reject);
  });
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readText(request);
  return body.trim() ? JSON.parse(body) as Record<string, unknown> : {};
}

function appendMessage(input: Omit<Parameters<typeof createChatMessage>[0], "id">): ChatMessage {
  return chats.appendMessage(createChatMessage({ id: randomUUID(), ...input }));
}

function compactTitle(request: string): string {
  const clean = request.replace(/\s+/g, " ").trim();
  if (!clean) return "New chat";
  return clean.length > 64 ? `${clean.slice(0, 61)}…` : clean;
}

function formatProjectPlan(plan: ProjectPlan): string {
  const slices = plan.slices.map((slice, index) => [
    `## ${index + 1}. ${slice.title}`,
    "",
    `**Outcome:** ${slice.outcome}`,
    "",
    "**Scope**",
    ...slice.scope.map((item) => `- ${item}`),
    "",
    "**Acceptance criteria**",
    ...slice.acceptanceCriteria.map((item) => `- ${item}`),
  ].join("\n")).join("\n\n");

  return [
    "# Frontend phase plan",
    "",
    `**Goal:** ${plan.siteGoal}`,
    `**Audience:** ${plan.audience}`,
    `**Visual direction:** ${plan.visualDirection}`,
    `**Backend after frontend:** ${plan.backendRequired ? "Required" : "Not required"}`,
    "",
    "## Planned pages",
    ...plan.pages.map((page) => `- ${page}`),
    "",
    "## Planned capabilities",
    ...plan.features.map((feature) => `- ${feature}`),
    "",
    slices,
    "",
    "## Frontend completion criteria",
    ...plan.acceptanceCriteria.map((item) => `- ${item}`),
  ].join("\n");
}

function rootWorkflowSession(session: ChatSession): ChatSession {
  if (!session.parentSessionId) return session;
  return chats.findSession(session.parentSessionId) ?? session;
}

function migrateLegacyWorkflowSessions() {
  const all = chats.listSessions();
  const groups = new Map<string, ChatSession[]>();
  for (const session of all) {
    if (!session.repositoryPath) continue;
    const key = session.repositoryPath.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), session]);
  }
  const internalTitle = / · (Slice 1|Next slice|Revision|Backend planning)$/;
  for (const group of groups.values()) {
    const unparented = group.filter((session) => !session.parentSessionId);
    if (unparented.length < 2) continue;
    const root = [...unparented].filter((session) => !internalTitle.test(session.title)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
      ?? [...unparented].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    for (const session of unparented) {
      if (session.id === root.id || !internalTitle.test(session.title)) continue;
      chats.updateSession(session.id, {
        parentSessionId: root.id,
        workflowRole: session.title.endsWith(" · Backend planning") ? "backend" : "frontend_slice",
      });
    }
  }
}

migrateLegacyWorkflowSessions();

function describeToolEvent(event: Record<string, unknown>): string | null {
  const type = String(event.type ?? "");
  const tool = String(event.tool ?? "tool");
  if (type === "tool.started") return `Running ${tool}`;
  if (type === "tool.failed") return `${tool} failed: ${String(event.message ?? "Unknown error")}`;
  if (type === "tool.completed") {
    const output = event.output as Record<string, unknown> | undefined;
    if (tool === "web_search" && Array.isArray(output?.results)) return `Web search completed with ${output.results.length} result(s).`;
    if (tool === "web_fetch") return `Fetched ${String(output?.url ?? "web page")}.`;
    return `${tool} completed.`;
  }
  return null;
}

async function syncInternetToCore() {
  const config = internet.load();
  const credential = internet.credential();
  try {
    const response = await fetch(`${coreUrl}/api/tools`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ internetEnabled: config.internetEnabled, ollamaApiKey: credential ?? "", clearApiKey: !credential }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Core tool service returned ${response.status}.`);
    return config.internetEnabled ? internet.markAvailable() : internet.load();
  } catch (error) {
    return internet.markConnectionFailed(error instanceof Error ? error.message : String(error));
  }
}

function toolStatus() {
  const config = internet.load();
  const runtimeAvailable = config.state === "available";
  return {
    provider: config.provider,
    internetEnabled: config.internetEnabled,
    configurationState: config.state,
    credentialConfigured: config.credentialConfigured,
    webFetchAvailable: runtimeAvailable,
    webSearchAvailable: runtimeAvailable && config.credentialConfigured,
    lastConnectionError: config.lastConnectionError,
    lastCheckedAt: config.lastCheckedAt,
    updatedAt: config.updatedAt,
  };
}

async function loadSessionRuntime(session: ChatSession) {
  const latestTaskId = chats.latestTaskId(session.id);
  if (!latestTaskId) return { session, latestTaskId: null, task: null, approval: null, escalation: null, projectPlanApproval: false, runtimeAvailable: true };
  try {
    const upstream = await fetch(`${coreUrl}/api/tasks/${encodeURIComponent(latestTaskId)}/approval`, { signal: AbortSignal.timeout(5_000) });
    if (!upstream.ok) throw new Error(`Core task state returned ${upstream.status}.`);
    const body = await upstream.json() as {
      task?: { id: string; state: string };
      approval?: { id: string; taskId: string; status: "REQUESTED" | "APPROVED" | "REJECTED"; worktreePath: string | null; baseCommit: string | null } | null;
      projectPlanApproval?: boolean;
    };
    let restoredSession = session;
    let escalation = chats.findModeEscalation(latestTaskId);
    const pending = body.task?.state === "AWAITING_APPROVAL" && body.approval?.status === "REQUESTED";
    if (!pending && escalation) {
      if (body.approval?.status === "APPROVED" && restoredSession.activeMode === "plan") {
        restoredSession = chats.updateSession(restoredSession.id, { activeMode: "edit" }) ?? restoredSession;
      }
      chats.deleteModeEscalation(latestTaskId);
      escalation = null;
    }
    return {
      session: restoredSession,
      latestTaskId,
      task: body.task ?? null,
      approval: body.approval ?? null,
      escalation: pending ? escalation : null,
      projectPlanApproval: pending && body.projectPlanApproval === true,
      runtimeAvailable: true,
    };
  } catch {
    return { session, latestTaskId, task: null, approval: null, escalation: chats.findModeEscalation(latestTaskId), projectPlanApproval: false, runtimeAvailable: false };
  }
}

async function proxyJson(request: IncomingMessage, response: ServerResponse) {
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await readText(request);
  try {
    const upstream = await fetch(`${coreUrl}${request.url ?? "/"}`, {
      method: request.method,
      headers: body === undefined ? undefined : { "content-type": request.headers["content-type"] ?? "application/json" },
      body: body === undefined ? undefined : body,
      signal: AbortSignal.timeout(120_000),
    });
    const text = await upstream.text();
    response.writeHead(upstream.status, headers(upstream.headers.get("content-type") ?? "application/json"));
    response.end(text);
  } catch (error) {
    send(response, 502, { error: error instanceof Error ? error.message : "Core service unavailable" });
  }
}

async function pipeExecution(taskId: string, session: ChatSession, emitToClient: EventSink, controller: AbortController) {
  const upstream = await fetch(`${coreUrl}/api/tasks/${encodeURIComponent(taskId)}/execute`, {
    method: "POST",
    signal: controller.signal,
  });
  if (!upstream.ok || !upstream.body) {
    const message = await upstream.text();
    throw new Error(message || `Execution failed (${upstream.status}).`);
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let assistantText = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === "message.delta") assistantText += String(event.text ?? "");
      const toolText = describeToolEvent(event);
      if (toolText && event.type !== "tool.started") appendMessage({ sessionId: session.id, taskId, role: event.type === "tool.failed" ? "system" : "tool", kind: event.type === "tool.failed" ? "warning" : "tool", text: toolText, metadata: event });
      if (event.type === "implementation.summary") {
        appendMessage({ sessionId: session.id, taskId, role: "system", kind: "status", text: "Implementation changes are ready in the Changes panel.", metadata: event });
      }
      if (event.type === "review.completed") {
        const review = event.review as { summary?: string } | undefined;
        if (review?.summary) appendMessage({ sessionId: session.id, taskId, role: "system", kind: "evidence", text: review.summary, metadata: event });
      }
      if (event.type === "runtime.failed" || event.type === "stream.failed" || event.type === "stream.blocked" || event.type === "design.review.blocked") {
        appendMessage({
          sessionId: session.id,
          taskId,
          role: "system",
          kind: "warning",
          text: String(event.message ?? "The frontend workflow needs attention."),
          metadata: event,
        });
      }
      emitToClient(event);
    }
    if (done) break;
  }
  if (buffer.trim()) emitToClient(JSON.parse(buffer) as Record<string, unknown>);
  if (assistantText.trim()) appendMessage({ sessionId: session.id, taskId, role: "assistant", kind: "prose", text: assistantText.trim() });
}

async function approveCoreTask(taskId: string) {
  const approval = await fetch(`${coreUrl}/api/tasks/${encodeURIComponent(taskId)}/approval`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision: "approve" }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await approval.json().catch(() => ({})) as Record<string, unknown>;
  if (!approval.ok) throw new Error(String(body.error ?? `Approval failed (${approval.status}).`));
  return body;
}

async function coreTaskRuntime(taskId: string) {
  const response = await fetch(`${coreUrl}/api/tasks/${encodeURIComponent(taskId)}/approval`, { signal: AbortSignal.timeout(10_000) });
  const body = await response.json().catch(() => ({})) as { task?: { state?: string }; error?: string };
  if (!response.ok) throw new Error(body.error ?? `Unable to read task state (${response.status}).`);
  return body;
}

async function saveVerifiedFrontendSlice(taskId: string, session: ChatSession, emitToClient: EventSink) {
  const runtime = await coreTaskRuntime(taskId);
  if (runtime.task?.state !== "DELIVERY_READY") return false;
  const response = await fetch(`${coreUrl}/api/tasks/${encodeURIComponent(taskId)}/delivery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "commit", message: "BORG verified frontend slice checkpoint" }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await response.json().catch(() => ({})) as { delivery?: { commit?: string }; error?: string };
  if (!response.ok) throw new Error(body.error ?? "Unable to checkpoint the verified frontend slice.");
  appendMessage({
    sessionId: session.id,
    taskId,
    role: "system",
    kind: "status",
    text: `Verified frontend slice checkpointed${body.delivery?.commit ? ` as ${body.delivery.commit}` : ""}. The primary project now contains this slice.`,
  });
  emitToClient({ type: "slice.checkpointed", taskId, commit: body.delivery?.commit ?? null });
  return true;
}

function sliceLaunchPrompt(action: "initial" | "advance" | "revise" | "backend", feedback: string) {
  if (action === "initial") return "Start the first approved frontend slice. Use the approved phase plan, approved design brief, and current-slice docs as scope authority; do not re-plan the whole website.";
  if (action === "advance" && !feedback.trim()) return "Approved. Continue directly to the next frontend slice in the frozen phase plan.";
  return feedback.trim();
}

async function launchFrontendWorkflowSession(parent: ChatSession, action: "initial" | "advance" | "revise" | "backend", feedback = "") {
  const root = rootWorkflowSession(parent);
  if (!root.repositoryPath) throw new Error("The website session is not attached to a repository.");
  const currentAccess = access.load();
  if (currentAccess.repositoryPath !== root.repositoryPath) access.save({ repositoryPath: root.repositoryPath, documents: currentAccess.documents });
  const selectedSlice = readSliceState(root.repositoryPath);
  const key = `${root.repositoryPath.toLowerCase()}::${action}::${selectedSlice?.current ?? -1}::${selectedSlice?.lastTaskId ?? "none"}`;
  const active = frontendLaunches.get(key);
  if (active) return active.session;

  const label = action === "initial" ? "Slice 1" : action === "advance" ? "Next slice" : action === "backend" ? "Backend planning" : "Revision";
  const activeMode: PermissionMode = action === "backend" ? "plan" : "edit";
  const session = createChatSession({
    id: randomUUID(),
    title: `${root.title} · ${label}`,
    activeMode,
    repositoryPath: root.repositoryPath,
    workspaceId: root.workspaceId,
    provider: root.provider,
    model: root.model,
    parentSessionId: root.id,
    workflowRole: action === "backend" ? "backend" : "frontend_slice",
  });
  chats.saveSession(session);

  const prompt = sliceLaunchPrompt(action, feedback);
  if (!prompt) throw new Error("Feedback is required for this workflow action.");

  let markStarted: (() => void) | null = null;
  const started = new Promise<void>((resolveStarted) => { markStarted = resolveStarted; });
  const run = streamChat(session, prompt, (event) => {
    if (event.type === "task.created") markStarted?.();
  }, action).catch((error) => {
    appendMessage({
      sessionId: session.id,
      role: "system",
      kind: "warning",
      text: error instanceof Error ? error.message : "The server-owned frontend workflow failed.",
    });
  }).finally(() => {
    if (frontendLaunches.get(key)?.session.id === session.id) frontendLaunches.delete(key);
  });
  frontendLaunches.set(key, { session, run });
  await Promise.race([started, new Promise<void>((resolveStarted) => setTimeout(resolveStarted, 5_000))]);
  return session;
}

async function streamChat(session: ChatSession, prompt: string, emitToClient: EventSink, sliceAction?: string) {
  const controller = new AbortController();
  activeStreams.set(session.id, controller);
  try {
    appendMessage({ sessionId: session.id, role: "user", kind: "prose", text: prompt });
    if (session.title === "New chat") session = chats.updateSession(session.id, { title: compactTitle(prompt) }) ?? session;

    const upstream = await fetch(`${coreUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: session.workspaceId, request: prompt, mode: session.activeMode, sliceAction }),
      signal: controller.signal,
    });
    if (!upstream.ok || !upstream.body) throw new Error(`Planning stream failed (${upstream.status}).`);

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let taskId: string | null = null;
    let assistantText = "";
    let coreApproval: Record<string, unknown> | null = null;
    let projectPlanApproval = false;
    let structuredProjectPlanText: string | null = null;

    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type === "task.created") {
          const task = event.task as { id?: string } | undefined;
          taskId = task?.id ?? null;
          if (taskId) chats.bindTask(session.id, taskId);
        }
        if (event.type === "message.delta") assistantText += String(event.text ?? "");
        if (event.type === "project.plan.approval.requested") {
          coreApproval = event.approval as Record<string, unknown> | null;
          projectPlanApproval = true;
          const plan = event.projectPlan as ProjectPlan | undefined;
          if (plan?.version === 2 && Array.isArray(plan.slices) && plan.slices.length) structuredProjectPlanText = formatProjectPlan(plan);
          if (taskId && coreApproval) {
            appendMessage({ sessionId: session.id, taskId, role: "system", kind: "status", text: "Frontend phase plan is ready for approval. Approving it freezes the slice roadmap and authorizes the bounded frontend slice workflow.", metadata: { approval: coreApproval, projectPlan: event.projectPlan } });
          }
          emitToClient(event);
          continue;
        }
        if (event.type === "mode.escalation.requested") {
          coreApproval = event.approval as Record<string, unknown> | null;
          if (session.activeMode === "plan" && taskId && coreApproval) {
            const escalation = createModeEscalationRequest({
              id: randomUUID(),
              sessionId: session.id,
              taskId,
              planText: typeof event.planText === "string" ? event.planText : assistantText.trim(),
            });
            chats.saveModeEscalation(escalation);
            appendMessage({ sessionId: session.id, taskId, role: "system", kind: "plan", text: "PLAN is complete. Switching to EDIT is required before any mutation can occur.", metadata: { escalation, approval: coreApproval } });
            emitToClient({ type: "mode.escalation.requested", taskId, approval: coreApproval, escalation, message: "PLAN is read-only. Switch to Edit & Continue to execute the persisted plan." });
          }
          continue;
        }
        if (event.type === "approval.requested") {
          coreApproval = event.approval as Record<string, unknown> | null;
          continue;
        }
        const toolText = describeToolEvent(event);
        if (toolText && event.type !== "tool.started") {
          appendMessage({ sessionId: session.id, taskId, role: event.type === "tool.failed" ? "system" : "tool", kind: event.type === "tool.failed" ? "warning" : "tool", text: toolText, metadata: event });
          if (event.type === "tool.failed" && ["web_search", "web_fetch"].includes(String(event.tool ?? ""))) internet.markConnectionFailed(String(event.message ?? "Internet tool failed"));
          if (event.type === "tool.completed" && ["web_search", "web_fetch"].includes(String(event.tool ?? ""))) internet.markAvailable();
        }
        if (event.type !== "stream.completed" || session.activeMode === "ask" || session.activeMode === "plan") emitToClient(event);
      }
      if (done) break;
    }

    if (projectPlanApproval && structuredProjectPlanText) {
      appendMessage({ sessionId: session.id, taskId, role: "assistant", kind: "plan", text: structuredProjectPlanText });
    } else if (assistantText.trim()) {
      appendMessage({ sessionId: session.id, taskId, role: "assistant", kind: session.activeMode === "ask" ? "prose" : "plan", text: assistantText.trim() });
    }

    if (!projectPlanApproval && (session.activeMode === "edit" || session.activeMode === "agent") && taskId && coreApproval) {
      await approveCoreTask(taskId);
      emitToClient({ type: "mode.authorized", taskId, mode: session.activeMode, message: `${session.activeMode.toUpperCase()} authorization is active for this session.` });
      await pipeExecution(taskId, session, emitToClient, controller);
      if (sliceAction && sliceAction !== "backend") {
        const checkpointed = await saveVerifiedFrontendSlice(taskId, session, emitToClient);
        if (checkpointed && session.repositoryPath) {
          const slice = readSliceState(session.repositoryPath);
          const plan = readProjectPlan(session.repositoryPath);
          if (plan?.status === "approved" && slice?.status === "awaiting_feedback" && slice.lastTaskId === taskId && slice.current + 1 < plan.slices.length) {
            appendMessage({ sessionId: session.id, taskId, role: "system", kind: "status", text: `Starting slice ${slice.current + 2} of ${plan.slices.length}: ${plan.slices[slice.current + 1].title}.` });
            await launchFrontendWorkflowSession(session, "advance");
          }
        }
      }
      emitToClient({ type: "stream.completed", taskId });
    }
  } finally {
    if (activeStreams.get(session.id) === controller) activeStreams.delete(session.id);
  }
}

async function streamExecutionRoute(taskId: string, response: ServerResponse) {
  const session = chats.sessionForTask(taskId);
  if (!session) return send(response, 404, { error: "Chat session for task was not found." });
  const controller = new AbortController();
  activeStreams.set(session.id, controller);
  response.writeHead(200, headers("application/x-ndjson; charset=utf-8"));
  try {
    await pipeExecution(taskId, session, (event) => writeEvent(response, event), controller);
  } catch (error) {
    writeEvent(response, { type: "runtime.failed", taskId, message: error instanceof Error ? error.message : "Execution failed" });
  } finally {
    if (activeStreams.get(session.id) === controller) activeStreams.delete(session.id);
    response.end();
  }
}

const startupInternetSync = syncInternetToCore();

const server = createServer((request, response) => {
  if (request.method === "OPTIONS") return send(response, 204, null);

  if (request.method === "GET" && request.url === "/health") {
    void startupInternetSync.finally(() => {
      void fetch(`${coreUrl}/health`, { signal: AbortSignal.timeout(2_500) }).then(async (upstream) => {
        const core = await upstream.json().catch(() => ({}));
        send(response, 200, { status: "ok", gateway: true, core, sessions: chats.listSessions().length, tools: toolStatus() });
      }).catch(() => send(response, 200, { status: "ok", gateway: true, core: { runtimeConnected: false }, sessions: chats.listSessions().length, tools: toolStatus() }));
    });
    return;
  }

  if (request.method === "GET" && request.url === "/api/sessions") return send(response, 200, { sessions: chats.listSessions() });
  if (request.method === "POST" && request.url === "/api/websites") {
    void readJson(request).then(async (input) => {
      const name = typeof input.name === "string" ? input.name.trim() : "";
      const brief = typeof input.brief === "string" ? input.brief.trim() : "";
      const requestedTemplate = typeof input.template === "string" ? input.template : "";
      const template: WebsiteTemplate = websiteTemplates.includes(requestedTemplate as WebsiteTemplate) ? requestedTemplate as WebsiteTemplate : "saas-landing";
      if (!name) return send(response, 400, { error: "Website name is required." });
      const project = await createWebsiteProject(name, undefined, undefined, { template, originalBrief: brief });
      const savedAccess = access.save({ repositoryPath: project.path, documents: [] });
      const session = createChatSession({ id: randomUUID(), title: project.name, activeMode: "plan", repositoryPath: savedAccess.repositoryPath, workspaceId: project.slug, provider: "ollama", model: process.env.BORG_MODEL ?? "qwen3-coder:30b", parentSessionId: null, workflowRole: "primary" });
      chats.saveSession(session);
      const preview = await previews.ensure(project.path);
      return send(response, 201, { session, project, preview, access: access.describe(savedAccess) });
    }).catch((error) => send(response, 400, { error: error instanceof Error ? error.message : "Unable to create website." }));
    return;
  }
  const previewRoute = request.url?.match(/^\/api\/sessions\/([^/?]+)\/preview$/);
  if (previewRoute && request.method === "POST") {
    const session = chats.findSession(decodeURIComponent(previewRoute[1]));
    if (!session) return send(response, 404, { error: "Session not found." });
    const website = session.repositoryPath ? websiteInfo(session.repositoryPath) : null;
    if (!website) return send(response, 404, { error: "This session has no website preview." });
    void loadSessionRuntime(session).then(async (runtime) => {
      let preview: { url: string; status: string; processId?: string; pid?: number | null };
      if (runtime.latestTaskId && runtime.approval?.status === "APPROVED" && runtime.approval.worktreePath) {
        previews.stop(website.path);
        const upstream = await fetch(`${coreUrl}/api/tasks/${encodeURIComponent(runtime.latestTaskId)}/preview`, {
          method: "POST",
          signal: AbortSignal.timeout(195_000),
        });
        const body = await upstream.json().catch(() => ({})) as { preview?: typeof preview; error?: string };
        if (!upstream.ok || !body.preview) throw new Error(body.error ?? `Task preview failed (${upstream.status}).`);
        preview = body.preview;
      } else {
        preview = await previews.ensure(website.path);
      }
      const current = access.load();
      if (current.repositoryPath !== website.path) access.save({ repositoryPath: website.path, documents: current.documents });
      send(response, 200, { preview, project: website, access: access.describe() });
    }).catch((error) => send(response, 502, { error: error instanceof Error ? error.message : "Unable to start preview." }));
    return;
  }
  if (request.method === "POST" && request.url === "/api/sessions") {
    void readJson(request).then((input) => {
      const repositoryPath = input.repositoryPath === null ? null : access.load().repositoryPath;
      const requestedMode = String(input.activeMode ?? "plan").toLowerCase() as PermissionMode;
      const activeMode = permissionModes.includes(requestedMode) ? requestedMode : "plan";
      const session = createChatSession({
        id: randomUUID(),
        title: typeof input.title === "string" ? input.title : "New chat",
        activeMode,
        repositoryPath,
        workspaceId: typeof input.workspaceId === "string" ? input.workspaceId : "borg-code",
        provider: "ollama",
        model: typeof input.model === "string" ? input.model : process.env.BORG_MODEL ?? "qwen3-coder:30b",
        parentSessionId: null,
        workflowRole: "primary",
      });
      chats.saveSession(session);
      return send(response, 201, { session, messages: [] });
    }).catch((error) => send(response, 400, { error: error instanceof Error ? error.message : "Unable to create chat session" }));
    return;
  }

  const sessionRoute = request.url?.match(/^\/api\/sessions\/([^/?]+)$/);
  if (sessionRoute) {
    const sessionId = decodeURIComponent(sessionRoute[1]);
    if (request.method === "GET") {
      const session = chats.findSession(sessionId);
      if (!session) return send(response, 404, { error: "Session not found" });
      void loadSessionRuntime(session)
        .then((runtime) => send(response, 200, { ...runtime, messages: chats.listMessages(sessionId) }))
        .catch((error) => send(response, 502, { error: error instanceof Error ? error.message : "Unable to restore task runtime." }));
      return;
    }
    if (request.method === "PATCH") {
      void readJson(request).then((input) => {
        const requestedMode = input.activeMode === undefined ? undefined : String(input.activeMode).toLowerCase() as PermissionMode;
        if (requestedMode !== undefined && !permissionModes.includes(requestedMode)) return send(response, 400, { error: "Invalid mode" });
        const session = chats.updateSession(sessionId, {
          title: typeof input.title === "string" ? input.title : undefined,
          activeMode: requestedMode,
          repositoryPath: input.repositoryPath === null || typeof input.repositoryPath === "string" ? input.repositoryPath as string | null : undefined,
        });
        return session ? send(response, 200, { session }) : send(response, 404, { error: "Session not found" });
      }).catch((error) => send(response, 400, { error: error instanceof Error ? error.message : "Unable to update session" }));
      return;
    }
    if (request.method === "DELETE") {
      const session = chats.findSession(sessionId);
      if (!session) return send(response, 404, { deleted: false });
      const related = chats.listSessions().filter((candidate) => candidate.id === sessionId || candidate.parentSessionId === sessionId);
      for (const candidate of related) {
        activeStreams.get(candidate.id)?.abort();
        activeStreams.delete(candidate.id);
      }
      for (const candidate of related.filter((candidate) => candidate.id !== sessionId)) chats.deleteSession(candidate.id);
      return send(response, chats.deleteSession(sessionId) ? 200 : 404, { deleted: true });
    }
  }

  if (request.method === "GET" && request.url === "/api/access") return send(response, 200, { access: access.describe() });
  if (request.method === "POST" && request.url === "/api/access") {
    void readJson(request).then((input) => {
      const saved = access.save(input);
      const sessionId = typeof input.sessionId === "string" ? input.sessionId : null;
      if (sessionId) chats.updateSession(sessionId, { repositoryPath: saved.repositoryPath });
      return send(response, 200, { access: access.describe(saved) });
    }).catch((error) => send(response, 400, { error: error instanceof Error ? error.message : "Invalid access policy" }));
    return;
  }

  if (request.method === "GET" && request.url === "/api/tools") return send(response, 200, { tools: toolStatus() });
  if (request.method === "POST" && request.url === "/api/tools") {
    void readJson(request).then(async (input) => {
      internet.save({ internetEnabled: input.internetEnabled, apiKey: input.ollamaApiKey ?? input.apiKey, clearApiKey: input.clearApiKey });
      await syncInternetToCore();
      return send(response, 200, { tools: toolStatus() });
    }).catch((error) => {
      internet.markConnectionFailed(error instanceof Error ? error.message : "Unable to configure internet tools");
      return send(response, 400, { error: error instanceof Error ? error.message : "Unable to configure internet tools", tools: toolStatus() });
    });
    return;
  }

  if (request.method === "POST" && request.url === "/api/frontend-workflow/continue") {
    void readJson(request).then(async (input) => {
      const parent = chats.findSession(String(input.sessionId ?? ""));
      if (!parent) return send(response, 404, { error: "Website session not found." });
      const rawAction = String(input.action ?? "");
      if (!["initial", "advance", "revise", "backend"].includes(rawAction)) return send(response, 400, { error: "Invalid frontend workflow action." });
      const action = rawAction as "initial" | "advance" | "revise" | "backend";
      const feedback = String(input.feedback ?? "");
      if ((action === "revise" || action === "backend") && !feedback.trim()) return send(response, 400, { error: "Feedback is required for this workflow action." });
      const session = await launchFrontendWorkflowSession(parent, action, feedback);
      return send(response, 202, { session, workflowStarted: true });
    }).catch((error) => send(response, 400, { error: error instanceof Error ? error.message : "Unable to continue frontend workflow." }));
    return;
  }

  if (request.method === "POST" && request.url === "/api/chat") {
    response.writeHead(200, headers("application/x-ndjson; charset=utf-8"));
    void readJson(request).then(async (input) => {
      const sessionId = String(input.sessionId ?? "");
      const prompt = String(input.request ?? "").trim();
      const session = chats.findSession(sessionId);
      if (!session) throw new Error("A valid chat session is required.");
      if (!prompt) throw new Error("Request cannot be empty.");
      writeEvent(response, { type: "session.mode", sessionId, mode: session.activeMode });
      await streamChat(session, prompt, (event) => writeEvent(response, event), typeof input.sliceAction === "string" ? input.sliceAction : undefined);
    }).catch((error) => writeEvent(response, { type: "stream.failed", message: error instanceof Error ? error.message : "Invalid chat request" }))
      .finally(() => response.end());
    return;
  }

  const approvalRoute = request.url?.match(/^\/api\/tasks\/([^/]+)\/approval$/);
  if (request.method === "POST" && approvalRoute) {
    const taskId = decodeURIComponent(approvalRoute[1]);
    void readJson(request).then(async (input) => {
      const session = chats.sessionForTask(taskId);
      if (!session) return send(response, 404, { error: "Session for approval was not found." });
      const decision = String(input.decision ?? "").toLowerCase();
      const upstream = await fetch(`${coreUrl}/api/tasks/${encodeURIComponent(taskId)}/approval`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = await upstream.json().catch(() => ({})) as Record<string, unknown>;
      if (!upstream.ok) return send(response, upstream.status, body);

      const persistedPlan = session.repositoryPath ? readProjectPlan(session.repositoryPath) : null;
      const persistedSlice = session.repositoryPath ? readSliceState(session.repositoryPath) : null;
      const persistedProjectPlanApproval = decision === "approve"
        && session.workflowRole === "primary"
        && persistedPlan?.status === "approved"
        && persistedSlice?.status === "ready"
        && persistedSlice.lastTaskId === taskId;
      const projectPlanApproved = body.projectPlanApproved === true || persistedProjectPlanApproval;
      const escalated = decision === "approve" && session.activeMode === "plan" && !projectPlanApproved;
      const updatedSession = escalated ? chats.updateSession(session.id, { activeMode: "edit" }) ?? session : session;
      chats.deleteModeEscalation(taskId);
      appendMessage({
        sessionId: session.id,
        taskId,
        role: "system",
        kind: decision === "approve" ? "status" : "plan",
        text: projectPlanApproved
          ? "Frontend phase plan approved. The server is starting slice 1 automatically; each slice will plan, implement, verify, review, and checkpoint before feedback."
          : escalated
            ? "Mode escalated from PLAN to EDIT for the approved slice."
            : decision === "reject"
              ? "Stayed in PLAN. No mutation authorization was granted."
              : `${updatedSession.activeMode.toUpperCase()} authorization was confirmed.`,
      });
      const startedSession = projectPlanApproved && decision === "approve"
        ? await launchFrontendWorkflowSession(updatedSession, "initial")
        : null;
      return send(response, 200, { ...body, session: updatedSession, startedSession, workflowStarted: Boolean(startedSession) });
    }).catch((error) => send(response, 400, { error: error instanceof Error ? error.message : "Unable to decide approval" }));
    return;
  }

  const executeRoute = request.url?.match(/^\/api\/tasks\/([^/]+)\/execute$/);
  if (request.method === "POST" && executeRoute) {
    void streamExecutionRoute(decodeURIComponent(executeRoute[1]), response);
    return;
  }

  void proxyJson(request, response);
});

async function recoverApprovedFrontendPlans() {
  const sessions = chats.listSessions();
  const repositories = new Map<string, ChatSession>();
  for (const session of sessions) {
    if (!session.repositoryPath || session.parentSessionId) continue;
    if (!repositories.has(session.repositoryPath.toLowerCase())) repositories.set(session.repositoryPath.toLowerCase(), session);
  }
  for (const parent of repositories.values()) {
    try {
      if (!parent.repositoryPath || !websiteInfo(parent.repositoryPath)) continue;
      const plan = readProjectPlan(parent.repositoryPath);
      const slice = readSliceState(parent.repositoryPath);
      if (plan?.status !== "approved" || !slice) continue;
      if (slice.status === "awaiting_feedback" && slice.current + 1 < plan.slices.length) {
        const latest = sessions.filter((candidate) => candidate.repositoryPath?.toLowerCase() === parent.repositoryPath!.toLowerCase() && candidate.workflowRole === "frontend_slice")
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        if (latest && chats.latestTaskId(latest.id) === slice.lastTaskId) await launchFrontendWorkflowSession(parent, "advance");
        continue;
      }
      if (slice.status !== "ready") continue;
      const existing = sessions.find((candidate) => candidate.repositoryPath?.toLowerCase() === parent.repositoryPath!.toLowerCase()
        && candidate.activeMode === "edit"
        && candidate.title.includes("Slice 1")
        && chats.latestTaskId(candidate.id));
      if (!existing) {
        await launchFrontendWorkflowSession(parent, "initial");
        continue;
      }
      const runtime = await loadSessionRuntime(existing);
      if (!runtime.latestTaskId) continue;
      if (runtime.task?.state === "AWAITING_APPROVAL" && runtime.approval?.status === "REQUESTED") {
        await approveCoreTask(runtime.latestTaskId);
        const controller = new AbortController();
        activeStreams.set(existing.id, controller);
        try {
          await pipeExecution(runtime.latestTaskId, existing, () => undefined, controller);
          await saveVerifiedFrontendSlice(runtime.latestTaskId, existing, () => undefined);
        } finally {
          if (activeStreams.get(existing.id) === controller) activeStreams.delete(existing.id);
        }
      } else if (runtime.task?.state === "DELIVERY_READY") {
        await saveVerifiedFrontendSlice(runtime.latestTaskId, existing, () => undefined);
      }
    } catch (error) {
      console.error("[frontend-workflow] recovery failed", error);
    }
  }
}

server.listen(gatewayPort, "127.0.0.1", () => {
  console.log(`BORG desktop gateway listening on http://127.0.0.1:${gatewayPort}`);
  setTimeout(() => { void recoverApprovedFrontendPlans(); }, 750);
});

async function shutdown(signal: string) {
  console.log(`[lifecycle] gateway shutdown requested: ${signal}`);
  for (const controller of activeStreams.values()) controller.abort();
  activeStreams.clear();
  previews.stopAll();
  chats.close();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  process.exit(0);
}

process.once("SIGINT", () => { void shutdown("SIGINT"); });
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
