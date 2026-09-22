export interface BenchmarkGatewayHealth {
  status?: string;
  gateway?: boolean;
  core?: {
    runtimeConnected?: boolean;
    modelAvailable?: boolean;
    model?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface BenchmarkSession {
  id: string;
  title?: string;
  activeMode?: string;
  workspaceId?: string;
  workflowRole?: string;
  repositoryPath?: string | null;
}

export interface BenchmarkSessionRuntime {
  session: BenchmarkSession;
  latestTaskId: string | null;
  task: { id: string; state: string } | null;
  approval: { id?: string; taskId?: string; status?: string } | null;
  projectPlanApproval?: boolean;
  projectPlanRevisionApproval?: boolean;
  runtimeAvailable: boolean;
  runtimeActive?: boolean;
  [key: string]: unknown;
}

export interface BenchmarkRunView {
  stage: string;
  headline: string;
  detail?: string;
  nextAction: string;
  blocker?: { title?: string; detail?: string; action?: string } | null;
  verification?: { status?: string; visualStatus?: string | null };
}

export interface BenchmarkWorkflowStatus {
  taskId?: string;
  taskState: string;
  source?: string;
  phase: string;
  status: string;
  sliceIndex: number | null;
  sliceTotal: number | null;
  sliceTitle: string | null;
  verificationPassed: boolean | null;
  repairAttempt: number;
  nextAction: string;
  run: BenchmarkRunView;
  [key: string]: unknown;
}

export interface CreateBenchmarkWebsiteInput {
  name: string;
  brief: string;
  template?: string;
}

export interface CreateBenchmarkWebsiteResult {
  session: BenchmarkSession;
  project?: { slug?: string; path?: string; name?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface ChatStreamResult {
  events: Record<string, unknown>[];
  taskId: string | null;
}

export interface BenchmarkDebugSnapshot {
  version: number;
  generatedAt: string;
  readOnly: boolean;
  task: { id: string; state: string; attempts?: number; [key: string]: unknown };
  workflow: {
    version?: number;
    phase?: string;
    status?: string;
    sliceIndex?: number | null;
    sliceTotal?: number | null;
    sliceTitle?: string | null;
    nextAction?: string;
    repairAttempt?: number;
    attemptPhase?: string | null;
    verification?: { status?: string; attempt?: number; [key: string]: unknown };
    projectPlan?: {
      backendRequired?: boolean;
      sitemap?: Array<{ route?: string; [key: string]: unknown }>;
      [key: string]: unknown;
    } | null;
    [key: string]: unknown;
  } | null;
  approval: {
    status?: string;
    worktreePath?: string | null;
    baseCommit?: string | null;
    [key: string]: unknown;
  } | null;
  events: Array<{
    id: string;
    sourceType: string;
    occurredAt: string;
    workflowVersion?: number | null;
    status?: string;
    data?: Record<string, unknown>;
    [key: string]: unknown;
  }>;
  contextPacks: Array<{
    id: string;
    sliceId: string | null;
    characters: number;
    budgetCharacters: number;
    [key: string]: unknown;
  }>;
  modelContexts?: Array<{
    id: string;
    role?: string;
    model?: string;
    sliceId?: string | null;
    manifestCount?: number;
    createdAt?: string;
    [key: string]: unknown;
  }>;
  git: {
    worktreePath: string | null;
    worktreeExists: boolean | null;
    baseCommit?: string | null;
    headCommit?: string | null;
    [key: string]: unknown;
  };
  checkpoints: Array<{
    id: string;
    kind: string;
    taskState: string;
    workflowVersion?: number | null;
    verification?: { status?: string; [key: string]: unknown };
    [key: string]: unknown;
  }>;
  diagnostics?: Array<{ id?: string; severity?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export type BenchmarkFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function cleanBaseUrl(value: string) {
  return value.replace(/\/+$/, "");
}

async function responseError(response: Response) {
  const body = await response.text().catch(() => "");
  if (!body) return `HTTP ${response.status}`;
  try {
    const parsed = JSON.parse(body) as { error?: string };
    return parsed.error || body;
  } catch {
    return body;
  }
}

export class BorgBenchmarkClient {
  readonly baseUrl: string;
  private readonly fetchImpl: BenchmarkFetch;

  constructor(baseUrl = "http://127.0.0.1:4312", fetchImpl: BenchmarkFetch = fetch) {
    this.baseUrl = cleanBaseUrl(baseUrl);
    this.fetchImpl = fetchImpl;
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    if (!response.ok) throw new Error(await responseError(response));
    return response.json() as Promise<T>;
  }

  async health() {
    return this.json<BenchmarkGatewayHealth>("/health");
  }

  async createWebsite(input: CreateBenchmarkWebsiteInput) {
    return this.json<CreateBenchmarkWebsiteResult>("/api/websites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: input.name,
        brief: input.brief,
        template: input.template ?? "auto",
      }),
    });
  }

  async getSession(sessionId: string) {
    return this.json<BenchmarkSessionRuntime>(`/api/sessions/${encodeURIComponent(sessionId)}`);
  }

  async approveTask(taskId: string) {
    return this.json<Record<string, unknown>>(`/api/tasks/${encodeURIComponent(taskId)}/approval`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
  }

  async workflowStatus(taskId: string) {
    return this.json<BenchmarkWorkflowStatus>(`/api/tasks/${encodeURIComponent(taskId)}/workflow-status`);
  }

  async debugSnapshot(taskId: string) {
    const body = await this.json<{ snapshot: BenchmarkDebugSnapshot }>(`/api/control/tasks/${encodeURIComponent(taskId)}/snapshot`);
    return body.snapshot;
  }

  async submitPrompt(sessionId: string, request: string): Promise<ChatStreamResult> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, request }),
    });
    if (!response.ok || !response.body) throw new Error(await responseError(response));

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const events: Record<string, unknown>[] = [];
    let taskId: string | null = null;
    let buffer = "";

    const consume = (line: string) => {
      if (!line.trim()) return;
      const event = JSON.parse(line) as Record<string, unknown>;
      events.push(event);
      if (event.type === "task.created") {
        const task = event.task as { id?: string } | undefined;
        taskId = task?.id ?? taskId;
      }
      if (event.type === "stream.failed" || event.type === "runtime.failed") {
        throw new Error(String(event.message ?? "BORG planning stream failed."));
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) consume(line);
      if (done) break;
    }
    consume(buffer);
    return { events, taskId };
  }
}
