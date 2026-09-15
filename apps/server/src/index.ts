import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { ChatRequestSchema, type AgentEvent, type ApprovalRequest } from "@borg/core";
import { OllamaModel } from "@borg/models";
import { BorgAgent } from "@borg/orchestrator";
import { TaskStore } from "@borg/persistence";
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

const server = createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS") return json(response, 204, null);

    if (request.method === "GET" && request.url === "/api/health") {
      const [modelAvailable, runtimeAvailable] = await Promise.all([model.available(), runtime.available()]);
      return json(response, 200, { ok: true, model: { id: model.id, name: model.model, available: modelAvailable }, runtime: { id: runtime.id, available: runtimeAvailable } });
    }

    if (request.method === "GET" && request.url === "/api/tasks") return json(response, 200, { tasks: store.listTasks() });
    if (request.method === "GET" && request.url === "/api/approvals") return json(response, 200, { approvals: approvals.list() });

    const approvalMatch = request.url?.match(/^\/api\/approvals\/([^/]+)$/);
    if (request.method === "POST" && approvalMatch) {
      const body = await readJson(request) as { approved?: unknown };
      if (typeof body.approved !== "boolean") return json(response, 400, { error: "approved must be boolean" });
      const found = approvals.resolve(decodeURIComponent(approvalMatch[1]!), body.approved);
      return json(response, found ? 200 : 404, found ? { ok: true } : { error: "Approval not found" });
    }

    if (request.method === "POST" && request.url === "/api/chat") {
      const parsed = ChatRequestSchema.safeParse(await readJson(request));
      if (!parsed.success) return json(response, 400, { error: parsed.error.flatten() });

      const taskId = parsed.data.taskId ?? randomUUID();
      const workspaceRoot = resolve(parsed.data.workspaceRoot ?? process.cwd());
      store.createTask({ id: taskId, prompt: parsed.data.prompt, workspaceRoot, permissionMode: parsed.data.permissionMode });
      store.setStatus(taskId, "running");
      emit({ type: "task.started", taskId, at: new Date().toISOString(), prompt: parsed.data.prompt });

      try {
        const text = await agent.run({
          taskId,
          prompt: parsed.data.prompt,
          workspaceRoot,
          permissionMode: parsed.data.permissionMode,
          onEvent: emit,
          requestApproval: (approval) => approvals.request(approval)
        });
        store.setStatus(taskId, "completed");
        return json(response, 200, { taskId, text });
      } catch (error) {
        store.setStatus(taskId, "failed");
        const message = error instanceof Error ? error.message : String(error);
        emit({ type: "task.failed", taskId, at: new Date().toISOString(), error: message });
        return json(response, 500, { taskId, error: message });
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
