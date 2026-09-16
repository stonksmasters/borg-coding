import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { WorkspaceContext } from "@borg/context";
import { ChatRequestSchema, type AgentEvent, type ApprovalRequest } from "@borg/core";
import { OllamaModel } from "@borg/models";
import { BorgAgent } from "@borg/orchestrator";
import { TaskStore } from "@borg/persistence";
import { RepositoryTools } from "@borg/repository";
import { OpenCodeRuntime } from "@borg/runtime-opencode";

const host = process.env.BORG_HOST ?? "127.0.0.1";
const port = Number(process.env.BORG_PORT ?? 8787);
const stateDir = resolve(process.env.BORG_STATE_DIR ?? ".localcode");
mkdirSync(stateDir, { recursive: true });

const model = new OllamaModel({ model: process.env.BORG_MODEL ?? "qwen3-coder:30b", baseUrl: process.env.OLLAMA_URL });
const runtime = new OpenCodeRuntime();
const agent = new BorgAgent(model);
const store = new TaskStore(resolve(stateDir, "borg.sqlite"));

class ApprovalBroker {
  private readonly pending = new Map<string, { request: ApprovalRequest; resolve: (approved: boolean) => void }>();

  request(request: ApprovalRequest): Promise<boolean> {
    return new Promise((resolveApproval) => this.pending.set(request.approvalId, { request, resolve: resolveApproval }));
  }

  list(): ApprovalRequest[] {
    return [...this.pending.values()].map((item) => item.request);
  }

  resolve(approvalId: string, approved: boolean): boolean {
    const pending = this.pending.get(approvalId);
    if (!pending) return false;
    this.pending.delete(approvalId);
    pending.resolve(approved);
    return true;
  }
}

const approvals = new ApprovalBroker();

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "http://127.0.0.1:5173",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS"
  });
  response.end(status === 204 ? undefined : JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function workspaceRoot(value: unknown): Promise<string> {
  const root = resolve(typeof value === "string" && value.trim() ? value.trim() : process.cwd());
  const info = await stat(root);
  if (!info.isDirectory()) throw new Error(`Workspace root is not a directory: ${root}`);
  return root;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS") return json(response, 204, null);
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);

    if (request.method === "GET" && url.pathname === "/api/health") {
      const [modelAvailable, runtimeAvailable] = await Promise.all([model.available(), runtime.available()]);
      return json(response, 200, { ok: true, model: { id: model.id, name: model.model, available: modelAvailable }, runtime: { id: runtime.id, available: runtimeAvailable } });
    }

    if (request.method === "GET" && url.pathname === "/api/tasks") return json(response, 200, { tasks: store.listTasks() });
    if (request.method === "GET" && url.pathname === "/api/approvals") return json(response, 200, { approvals: approvals.list() });

    if (request.method === "POST" && url.pathname === "/api/workspace/index") {
      const body = await readJson(request) as { workspaceRoot?: unknown };
      const root = await workspaceRoot(body.workspaceRoot);
      const context = new WorkspaceContext(root);
      const summary = await context.buildIndex(true);
      return json(response, 200, { root, summary });
    }

    if (request.method === "GET" && url.pathname === "/api/workspace/files") {
      const root = await workspaceRoot(url.searchParams.get("root"));
      const context = new WorkspaceContext(root);
      const files = await context.listFiles();
      return json(response, 200, { root, files: files.slice(0, 2000) });
    }

    if (request.method === "GET" && url.pathname === "/api/workspace/diff") {
      const root = await workspaceRoot(url.searchParams.get("root"));
      const repository = new RepositoryTools(root);
      const [status, diff] = await Promise.all([repository.gitStatus(), repository.gitDiff()]);
      return json(response, 200, { root, status, diff });
    }

    if (request.method === "GET" && url.pathname === "/api/workspace/review") {
      const root = await workspaceRoot(url.searchParams.get("root"));
      const taskId = requiredString(url.searchParams.get("taskId"), "taskId");
      const repository = new RepositoryTools(root);
      const review = await repository.getTaskReview(taskId);
      return json(response, 200, { root, review });
    }

    if (request.method === "POST" && url.pathname === "/api/workspace/review") {
      const body = await readJson(request) as { workspaceRoot?: unknown; taskId?: unknown; action?: unknown; path?: unknown; hunkId?: unknown };
      const root = await workspaceRoot(body.workspaceRoot);
      const taskId = requiredString(body.taskId, "taskId");
      const action = requiredString(body.action, "action");
      const repository = new RepositoryTools(root);
      let review;

      if (action === "accept-all") review = await repository.acceptAllReviewChanges(taskId);
      else if (action === "reject-all") review = await repository.rejectAllReviewChanges(taskId);
      else if (action === "accept-file") review = await repository.acceptReviewFile(taskId, requiredString(body.path, "path"));
      else if (action === "reject-file") review = await repository.rejectReviewFile(taskId, requiredString(body.path, "path"));
      else if (action === "accept-hunk") review = await repository.acceptReviewHunk(taskId, requiredString(body.path, "path"), requiredString(body.hunkId, "hunkId"));
      else if (action === "reject-hunk") review = await repository.rejectReviewHunk(taskId, requiredString(body.path, "path"), requiredString(body.hunkId, "hunkId"));
      else return json(response, 400, { error: `Unsupported review action: ${action}` });

      const [status, diff] = await Promise.all([repository.gitStatus(), repository.gitDiff()]);
      return json(response, 200, { root, review, status, diff });
    }

    if (request.method === "POST" && url.pathname === "/api/workspace/undo") {
      const body = await readJson(request) as { workspaceRoot?: unknown; taskId?: unknown };
      if (typeof body.taskId !== "string" || !body.taskId.trim()) return json(response, 400, { error: "taskId is required" });
      const root = await workspaceRoot(body.workspaceRoot);
      const repository = new RepositoryTools(root);
      const restored = await repository.restoreLastCheckpoint(body.taskId);
      const [status, diff] = await Promise.all([repository.gitStatus(), repository.gitDiff()]);
      return json(response, 200, { restored, status, diff });
    }

    const approvalMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)$/);
    if (request.method === "POST" && approvalMatch) {
      const body = await readJson(request) as { approved?: unknown };
      if (typeof body.approved !== "boolean") return json(response, 400, { error: "approved must be boolean" });
      const found = approvals.resolve(decodeURIComponent(approvalMatch[1]!), body.approved);
      return json(response, found ? 200 : 404, found ? { ok: true } : { error: "Approval not found" });
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      const parsed = ChatRequestSchema.safeParse(await readJson(request));
      if (!parsed.success) return json(response, 400, { error: parsed.error.flatten() });

      const taskId = parsed.data.taskId ?? randomUUID();
      const root = await workspaceRoot(parsed.data.workspaceRoot);
      const repository = new RepositoryTools(root);
      await repository.captureTaskBaseline(taskId).catch(() => undefined);
      store.createTask({ id: taskId, prompt: parsed.data.prompt, workspaceRoot: root, permissionMode: parsed.data.permissionMode });
      store.setStatus(taskId, "running");
      emit({ type: "task.started", taskId, at: new Date().toISOString(), prompt: parsed.data.prompt });

      try {
        const text = await agent.run({
          taskId,
          prompt: parsed.data.prompt,
          workspaceRoot: root,
          permissionMode: parsed.data.permissionMode,
          onEvent: emit,
          requestApproval: (approval) => approvals.request(approval)
        });
        store.setStatus(taskId, "completed");
        return json(response, 200, { taskId, text, workspaceRoot: root });
      } catch (error) {
        store.setStatus(taskId, "failed");
        const message = error instanceof Error ? error.message : String(error);
        emit({ type: "task.failed", taskId, at: new Date().toISOString(), error: message });
        return json(response, 500, { taskId, error: message, workspaceRoot: root });
      }
    }

    return json(response, 404, { error: "Not found" });
  } catch (error) {
    return json(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

const sockets = new WebSocketServer({ server, path: "/events" });

function emit(event: AgentEvent): void {
  store.appendEvent(event);
  const payload = JSON.stringify(event);
  for (const client of sockets.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

server.listen(port, host, () => console.log(`BORG server listening on http://${host}:${port}`));
