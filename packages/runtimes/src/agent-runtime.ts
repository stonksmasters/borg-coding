export type AgentEvent =
  | { type: "message.delta"; text: string }
  | { type: "tool.started"; toolCallId: string; tool: string; input: unknown }
  | { type: "tool.completed"; toolCallId: string; output: unknown }
  | { type: "session.completed" }
  | { type: "session.failed"; error: string };

export interface CreateSessionOptions { projectPath: string; model: string; systemPrompt?: string; }
export interface AgentRequest { prompt: string; context?: string[]; }
export interface AgentSession { id: string; runtime: string; }
export interface ToolDefinition { id: string; description: string; inputSchema: unknown; }
export interface AgentRuntime {
  createSession(options: CreateSessionOptions): Promise<AgentSession>;
  prompt(sessionId: string, request: AgentRequest): AsyncIterable<AgentEvent>;
  cancel(sessionId: string): Promise<void>;
  registerTools(tools: ToolDefinition[]): Promise<void>;
  destroySession(sessionId: string): Promise<void>;
}
