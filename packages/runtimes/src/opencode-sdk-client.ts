import { createOpencodeClient, type Event, type OpencodeClient } from "@opencode-ai/sdk";
import type { AgentEvent, AgentRequest, CreateSessionOptions, ToolDefinition } from "./agent-runtime.ts";
import type { OpenCodeClient } from "./opencode-adapter.ts";

type SessionRecord = { client: OpencodeClient; directory: string; model: string; systemPrompt?: string; abortController?: AbortController };

function modelSelection(value: string) {
  const separator = value.indexOf("/");
  if (separator < 1 || separator === value.length - 1) return undefined;
  return { providerID: value.slice(0, separator), modelID: value.slice(separator + 1) };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  try { return JSON.stringify(error); } catch { return "OpenCode request failed."; }
}

/** Concrete AgentRuntime client for an already-running, loopback OpenCode server. */
export class OpenCodeSdkClient implements OpenCodeClient {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly registeredTools = new Map<string, ToolDefinition>();
  private readonly baseUrl: string;

  constructor(baseUrl = "http://127.0.0.1:4096") { this.baseUrl = baseUrl; }

  async health() {
    const response = await fetch(`${this.baseUrl}/global/health`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) throw new Error("OpenCode server is unavailable.");
    const result = await response.json() as { healthy?: boolean; version?: string };
    if (!result.healthy) throw new Error("OpenCode server is unavailable.");
    return result;
  }

  async createSession(options: CreateSessionOptions) {
    const client = createOpencodeClient({ baseUrl: this.baseUrl, directory: options.projectPath });
    const result = await client.session.create({ body: { title: "BORG task" }, query: { directory: options.projectPath } });
    if (result.error || !result.data) throw new Error(`Unable to create OpenCode session: ${errorMessage(result.error)}`);
    this.sessions.set(result.data.id, { client, directory: options.projectPath, model: options.model, systemPrompt: options.systemPrompt });
    return { id: result.data.id };
  }

  async *streamPrompt(sessionId: string, request: AgentRequest): AsyncIterable<AgentEvent> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown OpenCode session: ${sessionId}`);
    const abortController = new AbortController();
    session.abortController = abortController;
    const seenToolStates = new Map<string, string>();
    try {
      const subscription = await session.client.event.subscribe({ query: { directory: session.directory }, signal: abortController.signal });
      const prompt = [request.context?.join("\n\n"), request.prompt].filter(Boolean).join("\n\n");
      const selectedModel = modelSelection(session.model);
      const submitted = await session.client.session.promptAsync({
        path: { id: sessionId }, query: { directory: session.directory },
        body: {
          ...(selectedModel ? { model: selectedModel } : {}), ...(session.systemPrompt ? { system: session.systemPrompt } : {}),
          // OpenCode is transport-only here. Capabilities remain behind BORG's broker.
          tools: { bash: false, edit: false, write: false, patch: false, webfetch: false, read: false, grep: false, glob: false, list: false },
          parts: [{ type: "text", text: prompt }],
        },
      });
      if (submitted.error) throw new Error(errorMessage(submitted.error));

      for await (const event of subscription.stream) {
        const normalized = event as Event;
        if (normalized.type === "permission.updated" && normalized.properties.sessionID === sessionId) {
          await session.client.postSessionIdPermissionsPermissionId({ path: { id: sessionId, permissionID: normalized.properties.id }, query: { directory: session.directory }, body: { response: "reject" } });
          continue;
        }
        if (normalized.type === "message.part.updated" && normalized.properties.part.sessionID === sessionId) {
          const part = normalized.properties.part;
          if (part.type === "text" && normalized.properties.delta) yield { type: "message.delta", text: normalized.properties.delta };
          if (part.type === "tool") {
            const previous = seenToolStates.get(part.callID);
            if (part.state.status !== previous) {
              seenToolStates.set(part.callID, part.state.status);
              if (part.state.status === "running") yield { type: "tool.started", toolCallId: part.callID, tool: part.tool, input: part.state.input };
              if (part.state.status === "completed") yield { type: "tool.completed", toolCallId: part.callID, output: part.state.output };
              if (part.state.status === "error") { yield { type: "session.failed", error: part.state.error }; return; }
            }
          }
          continue;
        }
        if (normalized.type === "session.error" && normalized.properties.sessionID === sessionId) { yield { type: "session.failed", error: errorMessage(normalized.properties.error) }; return; }
        if (normalized.type === "session.idle" && normalized.properties.sessionID === sessionId) { yield { type: "session.completed" }; return; }
      }
      yield { type: "session.failed", error: "OpenCode event stream ended before the session completed." };
    } finally { session.abortController = undefined; }
  }

  async cancel(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.abortController?.abort();
    await session.client.session.abort({ path: { id: sessionId }, query: { directory: session.directory } });
  }

  async destroySession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.abortController?.abort();
    await session.client.session.delete({ path: { id: sessionId }, query: { directory: session.directory } });
    this.sessions.delete(sessionId);
  }

  async registerTools(tools: ToolDefinition[]) { for (const tool of tools) this.registeredTools.set(tool.id, tool); }
}
