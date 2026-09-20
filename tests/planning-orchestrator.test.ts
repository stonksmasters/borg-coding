import assert from "node:assert/strict";
import test from "node:test";
import { PlanningOrchestrator, type PlanningOrchestratorDependencies } from "../apps/server/src/planning-orchestrator.ts";
import { DisciplineRouter, TeamPolicyService } from "../packages/orchestration/src/index.ts";

function baseWorkflowState(taskId: string, projectId: string) {
  const now = new Date().toISOString();
  return {
    projectId,
    taskId,
    loop: "general",
    phase: "planning",
    status: "planning",
    nextAction: "plan",
    planApprovalId: null,
    planApproved: false,
    projectPlan: null,
    planRevisionResumeIndex: null,
    sliceIndex: null,
    sliceTotal: null,
    sliceTitle: null,
    feedback: [],
    handoff: null,
    pendingCommand: null,
    lastConsumedCommandId: null,
    verification: {
      status: "pending",
      attempt: 0,
      profile: null,
      summary: "",
      browserPassed: null,
      specialistPassed: null,
      resultSha256: null,
      completedAt: null,
    },
    recovery: {
      status: "inactive",
      category: null,
      previousTaskState: null,
      checkpointId: null,
      resumeAction: "none",
      reason: "",
      updatedAt: null,
    },
    repairAttempt: 0,
    recoveryCategory: null,
    detail: "test",
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function harness() {
  const events: Array<Record<string, unknown>> = [];
  const taskEvents: Array<{ taskId: string; type: string; payload: Record<string, unknown> }> = [];
  const workflowCalls: Array<{ name: string; value?: unknown }> = [];
  let currentWorkflow: ReturnType<typeof baseWorkflowState> | null = null;

  const workflow = {
    get: (_projectId: string) => currentWorkflow,
    start: (task: { id: string; projectId: string }, intent: string, detail: string) => {
      workflowCalls.push({ name: "start", value: { intent, detail } });
      currentWorkflow = { ...baseWorkflowState(task.id, task.projectId), detail };
      return currentWorkflow;
    },
    startFrontendSlice: () => {
      throw new Error("frontend slice start was not expected in this harness");
    },
    requestApproval: (task: any, approval: any, kind: string) => {
      workflowCalls.push({ name: "requestApproval", value: { kind, approvalId: approval.id } });
      const nextTask = { ...task, state: "AWAITING_APPROVAL", updatedAt: new Date().toISOString() };
      currentWorkflow = {
        ...(currentWorkflow ?? baseWorkflowState(task.id, task.projectId)),
        taskId: task.id,
        status: "awaiting_approval",
        nextAction: "await_approval",
        planApprovalId: approval.id,
        version: (currentWorkflow?.version ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      };
      return { task: nextTask, workflow: currentWorkflow };
    },
    setProjectPlan: () => {
      throw new Error("project plan mutation was not expected in this harness");
    },
  };

  const deps = {
    tasks: {
      listTasks: () => [],
    },
    workflow,
    access: {
      load: () => ({ repositoryPath: null, documents: [], updatedAt: new Date().toISOString() }),
      buildContext: () => "Approved repository context.",
      allowsRepositoryFile: () => false,
    },
    memory: {
      context: () => "",
    },
    tools: {
      refreshMemory: async () => ({ scanned: 0, updated: 0, removed: 0, truncated: false }),
    },
    disciplineRouter: new DisciplineRouter(),
    teamPolicies: new TeamPolicyService(),
    designDirector: {
      createBrief: async () => {
        throw new Error("Design Director should not run without a BORG website.");
      },
    },
    ollamaUrl: "http://127.0.0.1:11434",
    model: "test-model",
    runAgent: async (input: any) => {
      workflowCalls.push({ name: "runAgent", value: { mode: input.mode, role: input.role } });
      return { answer: "Plan\n1. Inspect the approved scope.\n2. Make the bounded change.\n3. Verify the result.", usedTools: false, budgetExhausted: false };
    },
    appendTaskEvent: (taskId: string, type: string, payload: Record<string, unknown>) => {
      taskEvents.push({ taskId, type, payload });
    },
    syncWorkflowProjection: (_task: any, state: any) => state,
    transitionTask: (task: any, state: string, emit?: (event: Record<string, unknown>) => void) => {
      const updated = { ...task, state, updatedAt: new Date().toISOString() };
      emit?.({ type: "task.state", taskId: task.id, state, workflow: currentWorkflow });
      return updated;
    },
    projectPlanFromWorkflow: () => null,
    sliceStateFromWorkflow: () => null,
    commitProjectRegistries: () => undefined,
    contextSourceHints: () => [],
    recordContextPack: () => undefined,
    recordModelInput: () => undefined,
    beginRole: (task: any, role: string, discipline: string, selectedModel: string | null) => ({
      id: "role-1",
      taskId: task.id,
      role,
      discipline,
      model: selectedModel,
      attempt: task.attempts,
      capabilities: [],
      specialistPacks: [],
      status: "active",
      startedAt: new Date().toISOString(),
      completedAt: null,
    }),
    finishRole: (assignment: any, status: string) => ({ ...assignment, status, completedAt: new Date().toISOString() }),
    recordHandoff: () => undefined,
    createCheckpointSnapshot: (task: any, kind: string) => ({
      id: "checkpoint-1",
      taskId: task.id,
      kind,
    }),
  } as unknown as PlanningOrchestratorDependencies;

  return {
    orchestrator: new PlanningOrchestrator(deps),
    events,
    taskEvents,
    workflowCalls,
    emit: (event: Record<string, unknown>) => events.push(event),
  };
}

test("PlanningOrchestrator keeps ASK planning read-only and completes without approval", async () => {
  const h = harness();
  const result = await h.orchestrator.run({
    mode: "ask",
    request: "Explain the repository architecture",
    projectId: "project-ask",
    authorityProjectId: "project-ask",
    sliceAction: "initial",
    scopeId: null,
    workflowCommandId: null,
  }, h.emit, new AbortController().signal);

  assert.equal(result.status, "completed");
  assert.equal(result.task.state, "COMPLETE");
  assert.ok(h.events.some((event) => event.type === "task.created"));
  assert.ok(h.events.some((event) => event.type === "message.delta"));
  assert.ok(h.events.some((event) => event.type === "stream.completed"));
  assert.ok(!h.events.some((event) => String(event.type).includes("approval.requested")));
  assert.deepEqual(
    h.workflowCalls.find((call) => call.name === "start")?.value,
    { intent: "general", detail: "Planning the requested project work." },
  );
  assert.deepEqual(
    h.workflowCalls.find((call) => call.name === "runAgent")?.value,
    { mode: "ask", role: "architect" },
  );
});

test("PlanningOrchestrator preserves mutation-capable approval boundary through Core", async () => {
  const h = harness();
  const result = await h.orchestrator.run({
    mode: "edit",
    request: "Refactor a helper safely",
    projectId: "project-edit",
    authorityProjectId: "project-edit",
    sliceAction: "initial",
    scopeId: null,
    workflowCommandId: null,
  }, h.emit, new AbortController().signal);

  assert.equal(result.status, "completed");
  assert.equal(result.task.state, "AWAITING_APPROVAL");
  assert.ok(h.events.some((event) => event.type === "approval.requested"));
  assert.ok(h.events.some((event) => event.type === "stream.completed"));
  assert.equal(
    (h.workflowCalls.find((call) => call.name === "requestApproval")?.value as { kind?: string } | undefined)?.kind,
    "execution",
  );
  assert.ok(h.taskEvents.some((event) => event.type === "MODEL_RESPONSE_COMPLETED"));
});
