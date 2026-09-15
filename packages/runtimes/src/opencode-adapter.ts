import type { AgentEvent, AgentRequest, AgentRuntime, AgentSession, CreateSessionOptions, ToolDefinition } from "./agent-runtime.ts";

export interface OpenCodeClient {
  createSession(options: CreateSessionOptions): Promise<{ id: string }>;
  streamPrompt(sessionId: string, request: AgentRequest): AsyncIterable<AgentEvent>;
  cancel(sessionId: string): Promise<void>;
  destroySession(sessionId: string): Promise<void>;
  registerTools(tools: ToolDefinition[]): Promise<void>;
}

export class OpenCodeAdapter implements AgentRuntime {
  constructor(private readonly client: OpenCodeClient) {}
  async createSession(options: CreateSessionOptions): Promise<AgentSession> { const session = await this.client.createSession(options); return { id: session.id, runtime: "opencode" }; }
  prompt(sessionId: string, request: AgentRequest) { return this.client.streamPrompt(sessionId, request); }
  cancel(sessionId: string) { return this.client.cancel(sessionId); }
  registerTools(tools: ToolDefinition[]) { return this.client.registerTools(tools); }
  destroySession(sessionId: string) { return this.client.destroySession(sessionId); }
}
