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

const gatewayPort = Number(process.env.BORG_GATEWAY_PORT ?? 4312);
const coreUrl = process.env.BORG_CORE_URL ?? "http://127.0.0.1:4311";
const databasePath = resolve(process.env.BORG_DATABASE_PATH ?? ".borg/borg.db");
mkdirSync(dirname(databasePath), { recursive: true });

const chats = new SqliteChatRepository(databasePath);
const access = new AccessController(resolve(".borg/access.json"));
const credentials = new DesktopCredentialStore();
const internet = new InternetConfigurationStore(resolve(".borg/internet.json"), credentials);
const activeStreams = new Map<string, AbortController>();

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

async function pipeExecution(taskId: string, session: ChatSession, response: ServerResponse, controller: AbortController) {
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
        const diff = event.diff as { stdout?: string } | undefined;
        appendMessage({ sessionId: session.id, taskId, role: "system", kind: "diff", text: diff?.stdout?.trim() || "No diff produced.", metadata: event });
      }
      if (event.type === "review.completed") {
        const review = event.review as { summary?: string } | undefined;
        if (review?.summary) appendMessage({ sessionId: session.id, taskId, role: "system", kind: "evidence", text: review.summary, metadata: event });
      }
      writeEvent(response, event);
    }
    if (done) break;
  }
  if (buffer.trim()) writeEvent(response, JSON.parse(buffer) as Record<string, unknown>);
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

async function streamChat(session: ChatSession, prompt: string, response: ServerResponse) {
  const controller = new AbortController();
  activeStreams.set(session.id, controller);
  try {
    appendMessage({ sessionId: session.id, role: "user", kind: "prose", text: prompt });
    if (session.title === "New chat") session = chats.updateSession(session.id, { title: compactTitle(prompt) }) ?? session;

    // The core planner currently creates the resumable approval checkpoint only for EDIT/AGENT.
    // PLAN is mapped to that planning capability internally so the same exact plan can be resumed,
    // but the durable session remains PLAN and no task context/worktree exists, so mutation tools are
    // unavailable until the explicit PLAN -> EDIT transition succeeds below.
    const corePlanningMode: PermissionMode = session.activeMode === "plan" ? "edit" : session.activeMode;
    const upstream = await fetch(`${coreUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: session.workspaceId, request: prompt, mode: corePlanningMode }),
      signal: controller.signal,
    });
    if (!upstream.ok || !upstream.body) throw new Error(`Planning stream failed (${upstream.status}).`);

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let taskId: string | null = null;
    let assistantText = "";
    let coreApproval: Record<string, unknown> | null = null;

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
        if (event.type === "approval.requested") {
          coreApproval = event.approval as Record<string, unknown> | null;
          if (session.activeMode === "plan" && taskId) {
            const escalation = createModeEscalationRequest({ id: randomUUID(), sessionId: session.id, taskId, planText: assistantText.trim() });
            appendMessage({ sessionId: session.id, taskId, role: "system", kind: "plan", text: "PLAN is complete. Switching to EDIT is required before any mutation can occur.", metadata: { escalation, approval: coreApproval } });
            writeEvent(response, { type: "mode.escalation.requested", taskId, approval: coreApproval, escalation, message: "PLAN is read-only. Switch to Edit & Continue to execute the proposed plan." });
          }
          continue;
        }
        const toolText = describeToolEvent(event);
        if (toolText && event.type !== "tool.started") {
          appendMessage({ sessionId: session.id, taskId, role: event.type === "tool.failed" ? "system" : "tool", kind: event.type === "tool.failed" ? "warning" : "tool", text: toolText, metadata: event });
          if (event.type === "tool.failed" && ["web_search", "web_fetch"].includes(String(event.tool ?? ""))) internet.markConnectionFailed(String(event.message ?? "Internet tool failed"));
          if (event.type === "tool.completed" && ["web_search", "web_fetch"].includes(String(event.tool ?? ""))) internet.markAvailable();
        }
        if (event.type !== "stream.completed" || session.activeMode === "ask" || session.activeMode === "plan") writeEvent(response, event);
      }
      if (done) break;
    }

    if (assistantText.trim()) appendMessage({ sessionId: session.id, taskId, role: "assistant", kind: session.activeMode === "ask" ? "prose" : "plan", text: assistantText.trim() });

    if ((session.activeMode === "edit" || session.activeMode === "agent") && taskId && coreApproval) {
      await approveCoreTask(taskId);
      writeEvent(response, { type: "mode.authorized", taskId, mode: session.activeMode, message: `${session.activeMode.toUpperCase()} authorization is active for this session.` });
      await pipeExecution(taskId, session, response, controller);
      writeEvent(response, { type: "stream.completed", taskId });
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
    await pipeExecution(taskId, session, response, controller);
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
  if (request.method === "POST" && request.url === "/api/sessions") {
    void readJson(request).then((input) => {
      const repositoryPath = access.load().repositoryPath;
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
      return send(response, 200, { session, messages: chats.listMessages(sessionId), latestTaskId: chats.latestTaskId(sessionId) });
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
      const stream = activeStreams.get(sessionId);
      stream?.abort();
      activeStreams.delete(sessionId);
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

  if (request.method === "POST" && request.url === "/api/chat") {
    response.writeHead(200, headers("application/x-ndjson; charset=utf-8"));
    void readJson(request).then(async (input) => {
      const sessionId = String(input.sessionId ?? "");
      const prompt = String(input.request ?? "").trim();
      const session = chats.findSession(sessionId);
      if (!session) throw new Error("A valid chat session is required.");
      if (!prompt) throw new Error("Request cannot be empty.");
      writeEvent(response, { type: "session.mode", sessionId, mode: session.activeMode });
      await streamChat(session, prompt, response);
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

      const escalated = decision === "approve" && session.activeMode === "plan";
      const updatedSession = escalated ? chats.updateSession(session.id, { activeMode: "edit" }) ?? session : session;
      appendMessage({
        sessionId: session.id,
        taskId,
        role: "system",
        kind: decision === "approve" ? "status" : "plan",
        text: escalated
          ? "Mode escalated from PLAN to EDIT. Approved execution may continue."
          : decision === "reject"
            ? "Stayed in PLAN. No mutation authorization was granted."
            : `${updatedSession.activeMode.toUpperCase()} authorization was confirmed.`,
      });
      return send(response, 200, { ...body, session: updatedSession });
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

server.listen(gatewayPort, "127.0.0.1", () => console.log(`BORG desktop gateway listening on http://127.0.0.1:${gatewayPort}`));

async function shutdown(signal: string) {
  console.log(`[lifecycle] gateway shutdown requested: ${signal}`);
  for (const controller of activeStreams.values()) controller.abort();
  activeStreams.clear();
  chats.close();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  process.exit(0);
}

process.once("SIGINT", () => { void shutdown("SIGINT"); });
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
