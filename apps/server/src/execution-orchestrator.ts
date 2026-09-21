import { randomUUID } from "node:crypto";
import {
  createApproval,
  type Approval,
  type EngineeringDiscipline,
  type EngineeringRole,
  type Finding,
  type ReviewFindingRecord,
  type RoleAssignment,
  type Task,
  type TaskCheckpoint,
  type WorkflowState,
} from "../../../packages/core/src/contracts.ts";
import { WorkflowEngine } from "../../../packages/core/src/workflow-engine.ts";
import {
  buildRepairContext,
  formatRepairContext,
  type RepairContext,
} from "../../../packages/core/src/execution-state.ts";
import { blockingReviewFindings } from "../../../packages/core/src/review-history.ts";
import { SqliteTaskRepository } from "../../../packages/persistence/src/sqlite-task-repository.ts";
import { AccessController } from "../../../packages/repository/src/access-controller.ts";
import type { MemoryNote } from "../../../packages/repository/src/repository-memory.ts";
import { ToolBroker } from "../../../packages/tools/src/tool-broker.ts";
import type { TaskToolContext } from "../../../packages/tools/src/worktree-tools.ts";
import {
  TeamPolicyService,
  selectSpecialistPacks,
  specialistSystemInstructions,
  verificationProfileFor,
  type SpecialistCapabilityPack,
} from "../../../packages/orchestration/src/index.ts";
import { websiteInfo } from "../../../packages/web-builder/src/project-bootstrap.ts";
import { preflightFailureMessage, runWorkspacePreflight } from "../../../packages/web-builder/src/workspace-preflight.ts";
import { websiteGenerationContext } from "../../../packages/web-builder/src/generation-context.ts";
import {
  compileFocusedFrontendContext,
  compileFrontendContext,
  compileStyleFrontendContext,
  type CompiledContext,
  type ContextItem,
} from "../../../packages/web-builder/src/context-compiler.ts";
import { updateVerifiedProjectModel } from "../../../packages/web-builder/src/project-model.ts";
import {
  currentSlice,
  markSliceReady,
  readPersistedDesignBrief,
  readProjectDocs,
  readSliceState,
  setFrontendWorkflowStage,
  slicePrompt,
  type ProjectPlan,
  type SliceState,
} from "../../../packages/web-builder/src/slice-docs.ts";
import {
  DesignBriefSchema,
  designBriefPrompt,
  type DesignBrief,
} from "../../../packages/design-intelligence/src/index.ts";
import { runOllamaAgent } from "./ollama-agent.ts";
import { resolveExecutionScopeMarkers, resolveExecutionTaskScope } from "./task-scope-resolver.ts";
import { classifyImplementationFailure, classifyObservedToolFailures, compactRecoveryEvidence } from "./recovery-policy.ts";
import { VerificationService } from "./verification-service.ts";
import { QualityGateService } from "./quality-gate-service.ts";
import { ProjectPlanRevisionService } from "./project-plan-revision-service.ts";
import { repairGroundingSnapshot, sourceMutationSnapshot } from "./execution-grounding.ts";

export type ExecutionEventSink = (event: Record<string, unknown>) => void;

type HandoffInput = {
  task: Task;
  fromRole: EngineeringRole;
  toRole: EngineeringRole;
  objective: string;
  constraints?: string[];
  repositoryContext?: string[];
  completedWork?: string[];
  changedFiles?: string[];
  evidence?: string[];
  openRisks?: string[];
  requiredNextAction: string;
};

export type ExecutionOrchestratorDependencies = {
  tasks: SqliteTaskRepository;
  workflow: WorkflowEngine;
  tools: ToolBroker;
  teamPolicies: TeamPolicyService;
  access: AccessController;
  verificationService: VerificationService;
  qualityGateService: QualityGateService;
  projectPlanRevisionService: ProjectPlanRevisionService;
  ollamaUrl: string;
  model: string;
  maxRepairAttempts: number;
  maxDesignRefinements: number;
  appendTaskEvent(taskId: string, type: string, payload: Record<string, unknown>): void;
  syncWorkflowProjection(task: Task, state: WorkflowState): WorkflowState;
  taskProjectRepository(taskId: string): string | null;
  latestDesignBrief(taskId: string): DesignBrief | null;
  taskWorkflowAuthorityProjectId(taskId: string): string | null;
  projectPlanFromWorkflow(state: WorkflowState | null, fallbackRoot: string | null): ProjectPlan | null;
  sliceStateFromWorkflow(state: WorkflowState | null, plan: ProjectPlan | null, fallbackRoot: string | null): SliceState | null;
  recordModelInput(taskId: string, role: string, selectedModel: string, sliceId: string | null, manifest: ContextItem[], body: string): void;
  recordContextPack(taskId: string, projectId: string, pack: CompiledContext): unknown;
  beginRole(task: Task, role: EngineeringRole, discipline: EngineeringDiscipline, selectedModel: string | null, packs: readonly SpecialistCapabilityPack[], emit?: ExecutionEventSink): RoleAssignment;
  finishRole(assignment: RoleAssignment, status: "completed" | "failed", emit?: ExecutionEventSink): RoleAssignment;
  recordHandoff(input: HandoffInput, emit?: ExecutionEventSink): unknown;
  createCheckpointSnapshot(task: Task, kind: TaskCheckpoint["kind"]): TaskCheckpoint;
  recordCompletedReview(task: Task, findings: Finding[], verdict: "pass" | "repair" | "unknown", summary: string, resolutionEvidence?: string[]): { records: ReviewFindingRecord[] };
  recordMemoryNote(root: string, note: MemoryNote): void;
  contextSourceHints(root: string, query: string): string[];
};

export class ExecutionOrchestrator {
  private readonly deps: ExecutionOrchestratorDependencies;

  constructor(deps: ExecutionOrchestratorDependencies) {
    this.deps = deps;
  }

  async run(task: Task, approval: Approval, transportEmit: ExecutionEventSink): Promise<void> {
    if (task.state !== "IMPLEMENTING" || approval.status !== "APPROVED" || !approval.worktreePath || !approval.baseCommit) {
      throw new Error("Task is not ready for approved implementation.");
    }
    const taskId = task.id;
    const approvedWorktreePath = approval.worktreePath;
    const {
      tasks,
      workflow,
      tools,
      teamPolicies,
      access,
      verificationService,
      qualityGateService,
      projectPlanRevisionService,
      ollamaUrl,
      model,
      maxRepairAttempts,
      maxDesignRefinements,
      appendTaskEvent,
      syncWorkflowProjection,
      taskProjectRepository,
      latestDesignBrief,
      taskWorkflowAuthorityProjectId,
      projectPlanFromWorkflow,
      sliceStateFromWorkflow,
      recordModelInput,
      recordContextPack,
      beginRole,
      finishRole,
      recordHandoff,
      createCheckpointSnapshot,
      recordCompletedReview,
      recordMemoryNote,
      contextSourceHints,
    } = this.deps;
    const emit = (event: Record<string, unknown>) => {
      const enriched = { ...event, taskId };
      transportEmit(enriched);
      const eventType = String(event.type ?? "");
      if (eventType.startsWith("tool.") || eventType.startsWith("runtime.turn.")) appendTaskEvent(taskId, eventType.toUpperCase().replaceAll(".", "_"), enriched);
      if (eventType === "activity.updated") appendTaskEvent(taskId, "AGENT_ACTIVITY", { activity: event.activity });
    };
    const performPreflight = (reason: string) => {
      const report = runWorkspacePreflight(approvedWorktreePath, { reason, repair: true, expectedGitHead: approval.baseCommit ?? undefined });
      appendTaskEvent(taskId, "WORKSPACE_PREFLIGHT_COMPLETED", { report });
      emit({ type: "workspace.preflight.completed", report });
      if (!report.passed) {
        appendTaskEvent(taskId, "WORKSPACE_PREFLIGHT_BLOCKED", { report });
        throw new Error(`Workspace preflight blocked execution: ${preflightFailureMessage(report)}`);
      }
      return report;
    };
    const savedPlan = tasks.listEvents(taskId).findLast((event) =>
      event.type === "PLAN_REVISION_MODEL_RESPONSE_COMPLETED" || event.type === "MODEL_RESPONSE_COMPLETED"
    )?.payload.answer;
    const websiteProject = websiteInfo(approvedWorktreePath);
    const persistedDesignBrief = websiteProject ? readPersistedDesignBrief(approvedWorktreePath) : null;
    const parsedPersistedDesignBrief = persistedDesignBrief ? DesignBriefSchema.safeParse(persistedDesignBrief) : null;
    const designBrief = latestDesignBrief(taskId) ?? (parsedPersistedDesignBrief?.success ? parsedPersistedDesignBrief.data : null);
    const designContext = designBrief ? designBriefPrompt(designBrief) : "";
    const taskWorkflow = workflow.get(task.projectId);
    const ownedTaskWorkflow = taskWorkflow?.taskId === task.id ? taskWorkflow : null;
    const taskContext: TaskToolContext = {
      taskId,
      taskState: task.state,
      attemptPhase: ownedTaskWorkflow?.attemptPhase ?? null,
    };
    const refreshTaskContext = () => {
      const currentWorkflow = workflow.get(task.projectId);
      taskContext.taskState = task.state;
      taskContext.attemptPhase = currentWorkflow?.taskId === task.id ? currentWorkflow.attemptPhase : null;
    };
    const adoptCoreMutation = (
      result: { task: Task; workflow: WorkflowState },
      checkpointKind?: TaskCheckpoint["kind"],
    ) => {
      task = result.task;
      syncWorkflowProjection(task, result.workflow);
      if (checkpointKind) createCheckpointSnapshot(task, checkpointKind);
      emit({ type: "task.state", taskId, state: task.state, workflow: result.workflow });
      refreshTaskContext();
    };
    const authorityProjectId = taskWorkflowAuthorityProjectId(task.id) ?? task.projectId;
    const authorityWorkflow = workflow.get(authorityProjectId);
    const projectPlan = websiteProject ? projectPlanFromWorkflow(authorityWorkflow ?? ownedTaskWorkflow, approvedWorktreePath) : null;
    const executionScopeEvents = tasks.listEvents(taskId);
    const executionMarkers = resolveExecutionScopeMarkers(executionScopeEvents, Boolean(websiteProject));
    const focusedExecutionScope = executionMarkers.focus;
    const focusedBrowserRoute = focusedExecutionScope && projectPlan
      ? (() => {
          const staticRoute = (route: string | null | undefined) =>
            route && route.startsWith("/") && !/[:\[]/.test(route) ? route : null;
          if (focusedExecutionScope.type === "page") {
            return staticRoute(projectPlan.sitemap.find((page) => page.id === focusedExecutionScope.id)?.route);
          }
          const component = projectPlan.components.find((item) => item.id === focusedExecutionScope.id);
          return component?.usedBy
            .map((pageId) => staticRoute(projectPlan.sitemap.find((page) => page.id === pageId)?.route))
            .find((route): route is string => Boolean(route)) ?? null;
        })()
      : null;
    const sliceState = websiteProject && executionMarkers.frontendSliceSelected
      ? sliceStateFromWorkflow(ownedTaskWorkflow, projectPlan, approvedWorktreePath)
      : null;
    const priorDeliveredWebsiteTask = websiteProject
      ? tasks.listTasks(task.projectId).some((candidate) => candidate.id !== taskId && ["DELIVERY_READY", "DELIVERING", "COMPLETE"].includes(candidate.state))
      : false;
    const executionScope = resolveExecutionTaskScope({
      events: executionScopeEvents,
      hasWebsite: Boolean(websiteProject),
      hasProjectPlan: Boolean(projectPlan),
      hasSliceState: Boolean(sliceState),
      priorDeliveredWebsiteTask,
    });
    const styleWorkspace = executionScope.styleWorkspace;
    const websiteWorkflow = executionScope.websiteWorkflow;
    const websiteContext = websiteProject ? websiteGenerationContext({
      name: websiteProject.name,
      template: websiteProject.template,
      originalBrief: websiteProject.originalBrief,
    }, websiteWorkflow) : "";
    const backendHandoff = executionScope.backendPhase
      ? `Plan and implement backend work from the completed frontend contract. Preserve the frontend.\n${ownedTaskWorkflow?.handoff ?? readProjectDocs(approvedWorktreePath).filter((doc) => /\/(data-contract|handoff|decisions)\.md$/.test(doc.path)).map((doc) => `${doc.path}\n${doc.content.slice(0, 4000)}`).join("\n\n").slice(0, 12_000)}` : "";
    const styleExecutionContext = styleWorkspace && websiteProject
      ? "GLOBAL STYLE WORKSPACE. Preserve sitemap, routes, page purposes, component responsibilities, content hierarchy, interactions, and data behavior. Change shared visual primitives first: theme/tokens, typography, spacing, radii, shadows, layout rhythm, responsive styling, motion, and accessibility presentation. Avoid one-off component patches when a shared rule can solve the request. Verify representative pages at mobile and desktop widths."
      : "";
    const teamPolicy = teamPolicies.load(taskProjectRepository(taskId));
    const activeDisciplines = (task.disciplines.length ? task.disciplines : [teamPolicy.defaultDiscipline]) as EngineeringDiscipline[];
    const primaryDiscipline = activeDisciplines[0];
    const packs = selectSpecialistPacks(activeDisciplines);
    const specialistInstructions = {
      implementer: specialistSystemInstructions(packs, "implementer"),
      verifier: specialistSystemInstructions(packs, "verifier"),
      reviewer: specialistSystemInstructions(packs, "reviewer"),
    };
    const availableImplementationTools = tools.toolDefinitions("agent", taskContext, "implementer", activeDisciplines).map((tool) => tool.function.name);
    const verificationProfile = verificationProfileFor(packs);
    let activeRoleAssignment: RoleAssignment | null = null;

    try {

      const taskEvents = tasks.listEvents(taskId);
      const blockedRetry = taskEvents.findLast((event) => event.type === "BLOCKED_RETRY_REQUESTED");
      const blockedFailure = blockedRetry
        ? taskEvents.findLast((event) =>
            event.type === "REPAIR_LIMIT_REACHED"
            || event.type === "DESIGN_REVIEW_BLOCKED"
            || event.type === "DESIGN_REFINEMENT_LIMIT_REACHED"
            || event.type === "PLAN_REPAIR_REQUIRED")
        : null;
      let repairEvidence = blockedRetry
        ? `OPERATOR BLOCKED-TASK RETRY. Continue in the existing worktree. Repair only the latest failure; do not restart implementation or rediscover the repository.\n\nLatest failure evidence:\n${JSON.stringify(blockedFailure?.payload ?? {}).slice(0, 60_000)}`
        : "";
      let activeRepairContext: RepairContext | null = null;
      refreshTaskContext();
      let implementationBudgetContinuations = 0;
      let implementationBudgetExhausted = false;
      performPreflight("execution_start");
      const contextHintRoot = taskProjectRepository(taskId) ?? approvedWorktreePath;
      const contextWorkflowVersion = authorityWorkflow?.version ?? ownedTaskWorkflow?.version ?? null;
      const selectedSlice = sliceState && projectPlan ? projectPlan.slices[sliceState.current] ?? null : null;
      const focusedEntity = focusedExecutionScope && projectPlan
        ? (focusedExecutionScope.type === "page"
            ? projectPlan.sitemap.find((item) => item.id === focusedExecutionScope.id)
            : projectPlan.components.find((item) => item.id === focusedExecutionScope.id))
        : null;
      const compiledSlice = sliceState && projectPlan && selectedSlice ? compileFrontendContext({
        root: approvedWorktreePath,
        phase: "frontend",
        sliceIndex: sliceState.current,
        authority: { plan: projectPlan, state: sliceState, workflowVersion: contextWorkflowVersion },
        productContract: websiteContext,
        projectBrief: websiteProject?.originalBrief ?? undefined,
        sourceHints: contextSourceHints(contextHintRoot, [task.request, selectedSlice.title, selectedSlice.outcome, ...selectedSlice.scope].join(" ")),
        stage: taskContext.attemptPhase === "implementation" ? "execution" : "repair",
      }) : null;
      const compiledFocus = focusedExecutionScope && projectPlan ? compileFocusedFrontendContext({
        root: approvedWorktreePath,
        scope: focusedExecutionScope,
        productContract: websiteContext,
        projectBrief: websiteProject?.originalBrief ?? undefined,
        sourceHints: contextSourceHints(contextHintRoot, [task.request, focusedEntity?.name ?? "", focusedEntity?.purpose ?? ""].join(" ")),
        stage: taskContext.attemptPhase === "implementation" ? "execution" : "repair",
        authority: { plan: projectPlan, workflowVersion: contextWorkflowVersion },
      }) : null;
      const compiledStyle = styleWorkspace && projectPlan ? compileStyleFrontendContext({
        root: approvedWorktreePath,
        productContract: websiteContext,
        projectBrief: websiteProject?.originalBrief ?? undefined,
        sourceHints: contextSourceHints(contextHintRoot, `global styles theme typography spacing color layout responsive motion ${task.request}`),
        stage: taskContext.attemptPhase === "implementation" ? "execution" : "repair",
        authority: { plan: projectPlan, workflowVersion: contextWorkflowVersion },
      }) : null;
      const compiledExecutionContext = compiledFocus ?? compiledStyle ?? compiledSlice;
      if (compiledExecutionContext) recordContextPack(taskId, authorityProjectId, compiledExecutionContext);
      const activeSlicePrompt = sliceState && projectPlan ? `${slicePrompt(projectPlan, sliceState, availableImplementationTools)}\n\n${compiledSlice?.text ?? ""}` : "";
      const focusedExecutionPrompt = compiledFocus
        ? `FOCUSED ${focusedExecutionScope!.type.toUpperCase()} WORKSPACE [${focusedExecutionScope!.id}]. Modify only the selected ${focusedExecutionScope!.type} and direct dependencies represented in the focused context. Preserve unrelated pages/components and the approved global style system. Do not perform repository-wide redesign or planning.\n\n${compiledFocus.text}`
        : "";
      const styleExecutionPrompt = compiledStyle
        ? `${styleExecutionContext}\n\n${compiledStyle.text}`
        : styleExecutionContext;
      const repairAuthorityContext = projectPlan
        ? JSON.stringify({
            slice: selectedSlice ? {
              id: selectedSlice.id,
              title: selectedSlice.title,
              outcome: selectedSlice.outcome,
              scope: selectedSlice.scope,
              acceptanceCriteria: selectedSlice.acceptanceCriteria,
            } : null,
            page: selectedSlice
              ? projectPlan.sitemap.find((page) => page.id === selectedSlice.id) ?? null
              : focusedExecutionScope?.type === "page"
                ? projectPlan.sitemap.find((page) => page.id === focusedExecutionScope.id) ?? null
                : null,
            globalStyle: {
              direction: projectPlan.styles.direction,
              colors: projectPlan.styles.colors,
              typography: projectPlan.styles.typography,
              responsive: projectPlan.styles.responsive,
              accessibility: projectPlan.styles.accessibility,
              avoid: projectPlan.styles.avoid,
            },
          }, null, 2).slice(0, 10_000)
        : "";
      while (task) {
        if (task.attempts > 0) performPreflight("retry_start");
        refreshTaskContext();
        const attemptStartedInRepair = taskContext.attemptPhase !== "implementation";
        const preAttemptSnapshot = sourceMutationSnapshot(approvedWorktreePath);
        const implementerModel = teamPolicies.modelFor(teamPolicy, "implementer", model, primaryDiscipline);
        activeRoleAssignment = beginRole(task, "implementer", primaryDiscipline, implementerModel, packs, emit);
        const repairGrounding = attemptStartedInRepair
          ? repairGroundingSnapshot(approvedWorktreePath, activeRepairContext?.allowedFiles ?? [])
          : "";
        const scopedAuthorityPrompt = attemptStartedInRepair
          ? repairAuthorityContext
            ? `REPAIR AUTHORITY. Preserve this approved slice/page/style contract while fixing only the evidenced failure:\n${repairAuthorityContext}\n\n`
            : ""
          : `${activeSlicePrompt ? activeSlicePrompt + "\n\n" : ""}${focusedExecutionPrompt ? focusedExecutionPrompt + "\n\n" : ""}${styleExecutionPrompt ? styleExecutionPrompt + "\n\n" : ""}${backendHandoff ? backendHandoff + "\n\n" : ""}`;
        const scopedDesignContext = attemptStartedInRepair
          ? ""
          : `${designContext ? "\n\n" + designContext : ""}${websiteContext && !compiledExecutionContext ? "\n\n" + websiteContext : ""}`;
        const repairPrompt = repairEvidence
          ? [repairEvidence, repairGrounding].filter(Boolean).join("\n\n")
          : `Approved plan:\n${typeof savedPlan === "string" ? savedPlan : "No saved plan text was found; inspect the repository and implement conservatively."}`;
        let implementationResult: Awaited<ReturnType<typeof runOllamaAgent>>;
        try {
          implementationResult = await runOllamaAgent({
          ollamaUrl, model: implementerModel, tools, mode: "agent", taskContext, role: "implementer", disciplines: activeDisciplines, phase: "implementation", emit,
          limits: sliceState || focusedExecutionScope || styleWorkspace ? { toolRounds: 12, toolCalls: 28 } : undefined,
          onRequestBody: websiteProject ? (body) => recordModelInput(taskId, "implementer", implementerModel, compiledExecutionContext?.sliceId ?? null, compiledExecutionContext?.manifest ?? [], body) : undefined,
          messages: [
            ...(taskContext.attemptPhase !== "implementation" ? [{ role: "system" as const, content: "You are BORG's bounded repair agent. Resolve only the supplied failure evidence. Do not restart planning or perform repository-wide discovery. Inspect only implicated worktree files and direct dependencies, make the smallest root-cause correction, and return control to deterministic verification. Do not use base-repository language-intelligence tools during repair. Do not guess npm scripts or invent verification commands; BORG's deterministic verifier reads package.json after you return control." }] : []),
            { role: "system", content: `${scopedAuthorityPrompt}You are BORG's approved implementation agent. Work only inside the task worktree through the provided worktree tools. Create new files with worktree_write; it safely creates missing parent directories. Use worktree_patch for exact edits to existing files. Inspect Git status and diff; run relevant bounded commands when useful. For web-interface tasks, call browser_server_start to reuse the managed live preview, then use the URL it returns for browser_open and browser_responsive. Do not guess a fixed port or run a development server through worktree_command. Inspect and interact with the site through browser tools, and capture responsive screenshots, console/network failures, DOM evidence, and accessibility results. The development server is shared with the desktop Preview, so leave it running unless it crashes or an explicit restart is required; browser_close is enough to end the Chromium verification session. Browser verification is loopback-only and its latest report is attached to deterministic verification and fresh review. Use activity_update to keep the user informed in plain English: before each meaningful block of work, state what you are doing and which subsystem or files you expect to touch; report important discoveries that change your approach; after a meaningful mutation, explain what you changed; and before verification, say what you are checking. Do not emit activity updates for every trivial read, search, or tool call. The activity files field describes expected/current work context only; do not claim a file actually changed until runtime evidence proves it. Do not claim a mutation or verification that a tool result does not prove. The server will run deterministic verification after your work.\n\nActive specialist capability packs:\n${specialistInstructions.implementer}${scopedDesignContext}\n\nApproved worktree: ${approval.worktreePath}\nImmutable base commit: ${approval.baseCommit}` },
            { role: "user", content: `Implement this approved request:\n${task.request}\n\n${repairPrompt}` },
          ],
          });
        } catch (error) {
          if (activeRoleAssignment) finishRole(activeRoleAssignment, "failed", emit);
          activeRoleAssignment = null;
          const decision = classifyImplementationFailure(error, task.attempts, maxRepairAttempts);
          appendTaskEvent(taskId, "IMPLEMENTATION_FAILURE_CLASSIFIED", { decision, phase: "implementation" });
          emit({ type: "recovery.classified", decision, phase: "implementation" });
          if (decision.disposition === "retry") {
            const recoveryPreflight = performPreflight("implementation_recovery");
            activeRepairContext = null;
            repairEvidence = compactRecoveryEvidence(decision, recoveryPreflight);
            createCheckpointSnapshot(task, "pre_repair");
          }
          const recoveryOutcome = workflow.applyRecoveryDecision(task, decision, {
            retryKind: "technical_repair",
            eventType: "IMPLEMENTATION_RETRY_SCHEDULED",
          });
          adoptCoreMutation(recoveryOutcome);
          if (recoveryOutcome.action === "retry") {
            emit({
              type: "recovery.scheduled",
              attempt: recoveryOutcome.task.attempts,
              maximum: maxRepairAttempts,
              reason: decision.reason,
              category: decision.category,
              action: decision.action,
              message: decision.action,
            });
          }
          if (recoveryOutcome.action === "block") {
            emit({ type: "stream.blocked", message: decision.action });
            return;
          }
          continue;
        }
        const { answer, usedTools, budgetExhausted, toolFailures: directToolFailures = [] } = implementationResult;
        implementationBudgetExhausted = Boolean(budgetExhausted);
        if (sliceState || focusedExecutionScope || styleWorkspace) {
          const progressStatus = await tools.execute({ function: { name: "git_status", arguments: {} } }, "agent", taskContext, "implementer", activeDisciplines) as { stdout?: string };
          const postAttemptSnapshot = sourceMutationSnapshot(approvedWorktreePath);
          const initialSourceProgress = (progressStatus.stdout ?? "").split(/\r?\n/).filter(Boolean).some((line) => !line.includes(".localcode/build/"));
          const repairDelta = preAttemptSnapshot.fingerprint !== postAttemptSnapshot.fingerprint;
          const explainedNoMutation = /\b(?:no (?:source )?(?:change|mutation) (?:is )?required because|no mutation needed because|already resolved and no (?:source )?change is required)\b/i.test(answer);
          const toolFailures = directToolFailures
            .map((value) => String(value).slice(0, 2_000))
            .filter(Boolean)
            .slice(-5);
          const fatalRepairFailure = attemptStartedInRepair
            ? toolFailures
                .map((failure) => classifyImplementationFailure(failure, 0, maxRepairAttempts))
                .find((decision) => ["path_escape", "approval_violation", "repository_invalid", "permission_denied"].includes(decision.category))
            : null;
          const verifyWithoutMutation = attemptStartedInRepair && !repairDelta && !fatalRepairFailure;
          const sourceProgress = attemptStartedInRepair ? repairDelta : initialSourceProgress;
          if (attemptStartedInRepair && !repairDelta) {
            appendTaskEvent(taskId, explainedNoMutation ? "REPAIR_NO_MUTATION_EXPLAINED" : "REPAIR_NO_MUTATION_VERIFICATION_REQUIRED", {
              attempt: task.attempts,
              answer: answer.slice(0, 4_000),
              toolFailures,
            });
          }
          if ((!sourceProgress && !verifyWithoutMutation) || fatalRepairFailure) {
            if (activeRoleAssignment) finishRole(activeRoleAssignment, "failed", emit);
            activeRoleAssignment = null;
            const fallbackFailure = attemptStartedInRepair
              ? "The repair attempt did not produce a source mutation and cannot proceed without resolving the current fatal tool failure."
              : "The implementation attempt completed without any source-file progress.";
            const decision = fatalRepairFailure ?? classifyObservedToolFailures(
              toolFailures,
              task.attempts,
              maxRepairAttempts,
              fallbackFailure,
            );
            appendTaskEvent(taskId, attemptStartedInRepair ? "REPAIR_NO_PROGRESS" : "IMPLEMENTATION_NO_PROGRESS", {
              attempt: task.attempts,
              toolFailures,
              decision,
              preAttemptFingerprint: preAttemptSnapshot.fingerprint,
              postAttemptFingerprint: postAttemptSnapshot.fingerprint,
            });
            appendTaskEvent(taskId, "IMPLEMENTATION_FAILURE_CLASSIFIED", { decision, phase: "implementation" });
          emit({ type: "recovery.classified", decision, phase: "implementation" });
            if (decision.disposition === "retry") {
              const recoveryPreflight = performPreflight("no_progress_recovery");
              activeRepairContext = null;
              repairEvidence = compactRecoveryEvidence(decision, recoveryPreflight, toolFailures);
              createCheckpointSnapshot(task, "pre_repair");
            }
            const recoveryOutcome = workflow.applyRecoveryDecision(task, decision, {
              retryKind: "technical_repair",
              eventType: "IMPLEMENTATION_RETRY_SCHEDULED",
            });
            adoptCoreMutation(recoveryOutcome);
            if (recoveryOutcome.action === "retry") {
              emit({
                type: "recovery.scheduled",
                attempt: recoveryOutcome.task.attempts,
                maximum: maxRepairAttempts,
                reason: decision.reason,
                category: decision.category,
                action: decision.action,
                message: decision.action,
              });
            }
            if (recoveryOutcome.action === "block") {
              emit({ type: "stream.blocked", message: decision.action });
              return;
            }
            continue;
          }
        }
        if ((sliceState || focusedExecutionScope || styleWorkspace) && budgetExhausted && implementationBudgetContinuations < 1) {
          implementationBudgetContinuations += 1;
          appendTaskEvent(taskId, "IMPLEMENTATION_BUDGET_CONTINUATION", {
            continuation: implementationBudgetContinuations,
            toolBudgetExhausted: true,
          });
          if (activeRoleAssignment) finishRole(activeRoleAssignment, "completed", emit);
          activeRoleAssignment = null;
          repairEvidence = focusedExecutionScope
            ? `The bounded implementation tool budget ended before the focused ${focusedExecutionScope.type} edit demonstrated completion. Continue the SAME focused scope [${focusedExecutionScope.id}] from the current worktree state. Do not re-plan or inspect unrelated pages/components.`
            : styleWorkspace
              ? "The bounded implementation tool budget ended before the global style edit demonstrated completion. Continue the SAME style task from the current worktree state without changing site structure."
              : "The bounded implementation tool budget ended before the slice could explicitly demonstrate completion. Continue the SAME approved slice from the current worktree state. Do not re-plan or rediscover the project. Inspect only the changed/relevant files, finish any remaining acceptance criteria, and leave evidence for verification.";
          emit({ type: "runtime.notice", message: "Implementation reached its bounded tool budget. Continuing the same scoped task once with compact context instead of treating partial progress as complete." });
          continue;
        }
        if ((sliceState || focusedExecutionScope || styleWorkspace) && budgetExhausted) appendTaskEvent(taskId, "IMPLEMENTATION_BUDGET_EXHAUSTED", { continuations: implementationBudgetContinuations });
        appendTaskEvent(taskId, task.attempts > 0 ? "REPAIR_RESPONSE_COMPLETED" : "IMPLEMENTATION_RESPONSE_COMPLETED", { runtime: "ollama", model: implementerModel, role: "implementer", answer, usedTools, budgetExhausted: Boolean(budgetExhausted), attempt: task.attempts });
        finishRole(activeRoleAssignment, "completed", emit);
        recordHandoff({
          task,
          fromRole: "implementer",
          toRole: "verifier",
          objective: task.request,
          completedWork: [task.attempts > 0 ? `Repair attempt ${task.attempts} completed.` : "Approved implementation completed."],
          evidence: [`Implementation response recorded with ${usedTools ? "tool use" : "no tool use"}.`],
          constraints: packs.flatMap((pack) => pack.riskRules),
          requiredNextAction: `Run the ${verificationProfile} deterministic profile and collect: ${packs.flatMap((pack) => pack.requiredEvidence).join(" ")}`,
        }, emit);
        const verifierModel = teamPolicies.modelFor(teamPolicy, "verifier", model, primaryDiscipline);
        activeRoleAssignment = beginRole(task, "verifier", primaryDiscipline, verifierModel, packs, emit);
        const implementationOutcome = workflow.completeImplementation(task);
        adoptCoreMutation(implementationOutcome, "implementation_complete");
        if (sliceState && projectPlan) setFrontendWorkflowStage(approvedWorktreePath, "slice_verifying", { currentSlice: sliceState.current, totalSlices: projectPlan.slices.length, taskId, detail: "Implementation produced source changes. Deterministic and browser verification are running." });
        emit({ type: "stage.updated", stage: "Verification", status: "active" });
        let verificationResult: Awaited<ReturnType<VerificationService["run"]>>;
        try {
          verificationResult = await verificationService.run({
            taskId,
            taskContext,
            activeDisciplines,
            packs,
            verificationProfile,
            specialistInstructions: specialistInstructions.verifier,
            focusedScope: focusedExecutionScope,
            focusedBrowserRoute,
          }, emit, (type, payload) => appendTaskEvent(taskId, type, payload), task.attempts);
        } catch (error) {
          if (activeRoleAssignment) finishRole(activeRoleAssignment, "failed", emit);
          activeRoleAssignment = null;
          const decision = classifyImplementationFailure(error, task.attempts, maxRepairAttempts);
          appendTaskEvent(taskId, "IMPLEMENTATION_FAILURE_CLASSIFIED", { decision, phase: "verification" });
          if (decision.disposition === "retry") {
            const recoveryPreflight = performPreflight("verification_recovery");
            activeRepairContext = null;
            repairEvidence = compactRecoveryEvidence(decision, recoveryPreflight);
            createCheckpointSnapshot(task, "pre_repair");
          }
          const recoveryOutcome = workflow.applyRecoveryDecision(task, decision, {
            retryKind: "technical_repair",
            eventType: "REPAIR_SCHEDULED",
          });
          adoptCoreMutation(recoveryOutcome);
          if (recoveryOutcome.action === "retry") {
            emit({
              type: "recovery.scheduled",
              attempt: recoveryOutcome.task.attempts,
              maximum: maxRepairAttempts,
              reason: decision.reason,
              category: decision.category,
              action: decision.action,
              message: decision.action,
            });
          }
          if (recoveryOutcome.action === "block") {
            emit({ type: "stream.blocked", message: decision.action });
            return;
          }
          continue;
        }
        const {
          deterministic: deterministicVerification,
          verification,
          failure: verificationFailure,
          summary: verificationSummary,
          resultSha256,
        } = verificationResult;
        const verifiedWorkflow = workflow.recordVerification(task, {
          passed: verification.passed,
          attempt: task.attempts,
          profile: verificationProfile,
          summary: verificationSummary,
          browserPassed: verification.browserEvidence?.passed ?? (verification.focusedBrowserFailure ? false : null),
          specialistPassed: verification.specialistEvidence?.passed ?? null,
          resultSha256,
          evidence: verification,
        });
        syncWorkflowProjection(task, verifiedWorkflow);
        if (verification.visualRegression && verification.visualRegression.status !== "disabled") {
          appendTaskEvent(taskId, "VISUAL_REGRESSION_COMPLETED", { report: verification.visualRegression, attempt: task.attempts });
          emit({ type: "visual.regression.completed", visualRegression: verification.visualRegression });
        }
        const verificationAttempt = task.attempts;
        const verificationOutcome = workflow.applyVerificationOutcome(task, {
          maximumRepairAttempts: maxRepairAttempts,
          reason: verificationFailure,
        });

        if (verificationOutcome.action !== "quality_review") {
          finishRole(activeRoleAssignment, "completed", emit);
          recordHandoff({
            task,
            fromRole: "verifier",
            toRole: "implementer",
            objective: task.request,
            evidence: [JSON.stringify(verification).slice(0, 20_000)],
            openRisks: [verificationFailure],
            requiredNextAction: "Repair only the evidenced verification failure.",
          }, emit);
          activeRoleAssignment = null;
          emit({ type: "stage.updated", stage: "Verification", status: "failed" });
          createCheckpointSnapshot(task, "pre_repair");
          adoptCoreMutation(verificationOutcome);

          if (verificationOutcome.action === "block") {
            appendTaskEvent(taskId, "REPAIR_LIMIT_REACHED", {
              attempts: verificationAttempt,
              verification,
            });
            emit({
              type: "stream.blocked",
              message: `Verification still failed after ${maxRepairAttempts} repair attempts. Changes remain isolated for inspection.`,
            });
            return;
          }

          const status = await tools.execute(
            { function: { name: "git_status", arguments: {} } },
            "agent",
            taskContext,
            "verifier",
            activeDisciplines,
          ) as { stdout?: string };
          const recentChanges = (status.stdout ?? "").split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).trim());
          const context = buildRepairContext({
            sliceId: compiledFocus?.sliceId ?? compiledSlice?.sliceId,
            attempt: verificationAttempt,
            results: deterministicVerification.results,
            recentChanges,
          });
          activeRepairContext = context;
          repairEvidence = `${formatRepairContext(context)}\n\nBrowser and specialist evidence:\n${JSON.stringify({
            browserEvidence: verification.browserEvidence,
            specialistEvidence: verification.specialistEvidence,
          }).slice(0, 12_000)}`;
          appendTaskEvent(taskId, "REPAIR_CONTEXT_CREATED", { context });
          continue;
        }

        const visualDecision = await qualityGateService.evaluateVisual({
          taskId,
          request: task.request,
          worktreePath: approvedWorktreePath,
          browserEvidence: verification.browserEvidence,
          designBrief,
          activeSlicePrompt,
          projectPlan,
          sliceState,
          attempt: task.attempts,
          emit,
          appendTaskEvent: (type, payload) => appendTaskEvent(taskId, type, payload),
          onVisionRequestBody: (body, selectedModel) => recordModelInput(taskId, "vision_reviewer", selectedModel, compiledSlice?.sliceId ?? null, [], body),
          onDesignRequestBody: (body, selectedModel) => recordModelInput(taskId, "visual_director", selectedModel, compiledSlice?.sliceId ?? null, [], body),
        });
        const visionReview = visualDecision.visionReview;
        const designReview = visualDecision.designReview;

        if (visualDecision.action === "repair_current_slice") {
          finishRole(activeRoleAssignment, "completed", emit);
          activeRoleAssignment = null;
          createCheckpointSnapshot(task, "pre_repair");

          const requestedQualityAction = visualDecision.source === "local_vision"
            ? "technical_repair" as const
            : "design_refinement" as const;
          const qualityOutcome = workflow.applyQualityOutcome(task, {
            action: requestedQualityAction,
            reason: visualDecision.reason,
            maximumRepairAttempts: maxRepairAttempts,
            maximumDesignRefinements: maxDesignRefinements,
          });
          adoptCoreMutation(qualityOutcome);

          if (visualDecision.source === "local_vision") {
            recordHandoff({
              task,
              fromRole: "verifier",
              toRole: "implementer",
              objective: task.request,
              evidence: [JSON.stringify(visualDecision.visionReview).slice(0, 20_000)],
              openRisks: [visualDecision.reason],
              requiredNextAction: "Repair only the evidenced visual defect.",
            }, emit);
            recordCompletedReview(task, visualDecision.findings, "repair", visualDecision.reason);
            emit({ type: "review.history.updated" });
            emit({ type: "stage.updated", stage: "Verification", status: "failed" });
            if (qualityOutcome.action === "block") {
              appendTaskEvent(taskId, "REPAIR_LIMIT_REACHED", {
                attempts: task.attempts,
                visionReview: visualDecision.visionReview,
              });
              emit({
                type: "stream.blocked",
                message: `Local vision review still found a blocking visual defect after ${maxRepairAttempts} repair attempts.`,
              });
              return;
            }
            repairEvidence = visualDecision.repairEvidence;
            continue;
          }

          emit({ type: "stage.updated", stage: "Visual Direction", status: "failed" });
          if (qualityOutcome.action === "block") {
            appendTaskEvent(taskId, "DESIGN_REFINEMENT_LIMIT_REACHED", {
              refinements: qualityOutcome.workflow.designRefinementAttempt,
              maximum: maxDesignRefinements,
              review: visualDecision.designReview,
            });
            emit({
              type: "stream.blocked",
              message: `Visual Director still requires current-slice refinement after ${maxDesignRefinements} dedicated design passes. Changes remain isolated for inspection.`,
            });
            return;
          }
          activeRepairContext = null;
          repairEvidence = visualDecision.repairEvidence;
          continue;
        }

        if (visualDecision.action === "revise_project_plan") {
          finishRole(activeRoleAssignment, "completed", emit);
          activeRoleAssignment = null;
          emit({ type: "stage.updated", stage: "Visual Direction", status: "failed" });

          if (!projectPlan || !sliceState || !websiteProject) {
            const blocked = workflow.applyQualityOutcome(task, {
              action: "block",
              reason: visualDecision.reason,
              maximumRepairAttempts: maxRepairAttempts,
              maximumDesignRefinements: maxDesignRefinements,
            });
            adoptCoreMutation(blocked);
            appendTaskEvent(taskId, "PLAN_REPAIR_REQUIRED", {
              reason: visualDecision.reason,
              review: visualDecision.designReview,
              error: "Durable project plan or active slice was unavailable for automatic plan revision.",
            });
            emit({ type: "stream.blocked", message: "The Visual Director requires a plan-level repair, but BORG could not resolve the durable active plan/slice needed to revise it safely." });
            return;
          }

          const revisionReason = visualDecision.reason;
          const checkpoint = createCheckpointSnapshot(task, "pre_repair");
          const recovered = workflow.applyQualityOutcome(task, {
            action: "replan",
            reason: revisionReason,
            maximumRepairAttempts: maxRepairAttempts,
            maximumDesignRefinements: maxDesignRefinements,
            checkpointId: checkpoint.id,
          });
          adoptCoreMutation(recovered);
          appendTaskEvent(taskId, "DESIGN_SCOPE_CONFLICT", {
            review: visualDecision.designReview,
            repairScope: visualDecision.scope,
            reason: revisionReason,
            currentSliceIndex: sliceState.current,
            currentSliceId: projectPlan.slices[sliceState.current]?.id ?? null,
          });
          appendTaskEvent(taskId, "PLAN_REPAIR_REQUIRED", {
            reason: revisionReason,
            repairScope: visualDecision.scope,
            review: visualDecision.designReview,
            checkpointId: checkpoint.id,
          });

          const revising = workflow.beginPlanRevision(task, revisionReason);
          adoptCoreMutation(revising);
          emit({ type: "stage.updated", stage: "Plan", status: "active", message: "The current slice cannot satisfy the product-quality review. Revising the project plan without discarding the existing worktree." });

          const revisionModel = teamPolicies.modelFor(teamPolicy, "architect", model, primaryDiscipline);
          const revisionAssignment = beginRole(task, "architect", primaryDiscipline, revisionModel, packs, emit);
          const revisionBrief = websiteProject.originalBrief || task.request;
          const revision = await projectPlanRevisionService.generate({
            taskId,
            brief: revisionBrief,
            currentPlan: projectPlan,
            currentSliceIndex: sliceState.current,
            conflictReason: revisionReason,
            review: visualDecision.designReview,
            template: websiteProject.template,
            model: revisionModel,
            tools,
            disciplines: activeDisciplines,
            emit,
            appendTaskEvent: (type, payload) => appendTaskEvent(taskId, type, payload),
            onRequestBody: (body) => recordModelInput(taskId, "architect", revisionModel, `plan-revision:${projectPlan.revision + 1}`, [], body),
          });

          if (revision.status === "invalid") {
            finishRole(revisionAssignment, "failed", emit);
            const failedRevision = workflow.markRecoveryRequired(task, {
              category: "plan_repair_required",
              checkpointId: checkpoint.id,
              resumeAction: "replan",
              reason: revision.reason,
            });
            adoptCoreMutation(failedRevision);
            appendTaskEvent(taskId, "PLAN_REVISION_FAILED", {
              reason: revision.reason,
              validation: revision.validation,
            });
            emit({ type: "stream.blocked", message: revision.reason });
            return;
          }

          const planWorkflow = workflow.setProjectPlan(task, revision.candidate);
          syncWorkflowProjection(task, planWorkflow);
          const proposedPlan = planWorkflow.projectPlan as ProjectPlan;
          const projection = projectPlanRevisionService.persistAuthoritativeProjection({
            root: approvedWorktreePath,
            taskId,
            brief: revisionBrief,
            previousPlan: projectPlan,
            authoritativePlan: proposedPlan,
            resumeSliceIndex: planWorkflow.planRevisionResumeIndex ?? sliceState.current,
            revisionReason,
          });
          appendTaskEvent(taskId, "PROJECT_PLAN_COVERAGE_VALIDATED", {
            revision: proposedPlan.revision,
            coverage: projection.coverage,
            planRevision: true,
          });
          appendTaskEvent(taskId, "PROJECT_PLAN_REVISION_PROPOSED", {
            plan: proposedPlan,
            delta: projection.delta,
            repairScope: visualDecision.scope,
            reason: revisionReason,
            workflowVersion: planWorkflow.version,
          });
          appendTaskEvent(taskId, "PLAN_REVISION_MODEL_RESPONSE_COMPLETED", {
            runtime: "ollama",
            model: revisionModel,
            role: "architect",
            answer: revision.answer,
            usedTools: revision.usedTools,
          });
          finishRole(revisionAssignment, "completed", emit);
          emit({ type: "message.delta", taskId, text: revision.answer });

          const revisionApproval = {
            ...createApproval({ id: randomUUID(), taskId }),
            worktreePath: approval.worktreePath,
            baseCommit: approval.baseCommit,
          };
          const requestedRevision = workflow.requestApproval(task, revisionApproval, "project_plan_revision");
          task = requestedRevision.task;
          syncWorkflowProjection(task, requestedRevision.workflow);
          emit({ type: "task.state", taskId, state: task.state, workflow: requestedRevision.workflow });
          emit({
            type: "project.plan.approval.requested",
            taskId,
            approval: revisionApproval,
            planText: revision.answer,
            projectPlan: proposedPlan,
            planRevision: true,
            planDelta: projection.delta,
            planRevisionReason: revisionReason,
            message: `Plan revision ${proposedPlan.revision} resolves a ${visualDecision.scope.replaceAll("_", " ")} quality conflict. Approve it to resume the current worktree at the repaired slice boundary.`,
          });
          emit({ type: "stream.completed", taskId });
          return;
        }

        if (visualDecision.action === "block") {
          finishRole(activeRoleAssignment, "completed", emit);
          activeRoleAssignment = null;
          const blocked = workflow.applyQualityOutcome(task, {
            action: "block",
            reason: visualDecision.reason,
            maximumRepairAttempts: maxRepairAttempts,
            maximumDesignRefinements: maxDesignRefinements,
          });
          adoptCoreMutation(blocked);
          emit({
            type: "design.review.blocked",
            designReview: visualDecision.designReview,
            message: visualDecision.reason,
          });
          emit({ type: "stream.blocked", message: visualDecision.reason });
          return;
        }

        let status = await tools.execute({ function: { name: "git_status", arguments: {} } }, "agent", taskContext, "verifier", activeDisciplines) as { stdout?: string };
        let diff = await tools.execute({ function: { name: "git_diff", arguments: {} } }, "agent", taskContext, "verifier", activeDisciplines) as { stdout?: string };
        finishRole(activeRoleAssignment, "completed", emit);
        recordHandoff({
          task,
          fromRole: "verifier",
          toRole: "reviewer",
          objective: task.request,
          changedFiles: (status.stdout ?? "").split("\n").filter(Boolean).slice(0, 200),
          evidence: [
            JSON.stringify(verification).slice(0, 20_000),
            ...(designReview ? [`Visual Director: ${designReview.status} — ${designReview.summary}`] : []),
          ],
          requiredNextAction: "Review the verified diff from fresh context without mutation access.",
        }, emit);
        activeRoleAssignment = null;
        emit({ type: "stage.updated", stage: "Verification", status: "complete" });
        const qualityPass = workflow.applyQualityOutcome(task, {
          action: "pass",
          reason: "Visual and product quality gates passed.",
          maximumRepairAttempts: maxRepairAttempts,
          maximumDesignRefinements: maxDesignRefinements,
        });
        adoptCoreMutation(qualityPass, "verification_complete");
        if (sliceState && projectPlan) setFrontendWorkflowStage(approvedWorktreePath, "slice_reviewing", { currentSlice: sliceState.current, totalSlices: projectPlan.slices.length, taskId, detail: "Verification passed. Fresh review and visual quality gates are running." });
        emit({ type: "stage.updated", stage: "Review", status: "active" });
        const reviewerModel = teamPolicies.modelFor(teamPolicy, "reviewer", model, primaryDiscipline);
        activeRoleAssignment = beginRole(task, "reviewer", primaryDiscipline, reviewerModel, packs, emit);
        const freshDecision = await qualityGateService.evaluateFreshReview({
          taskId,
          request: task.request,
          projectPlan,
          sliceState,
          focusedScope: focusedExecutionScope,
          styleWorkspace,
          implementationBudgetExhausted,
          diff: diff.stdout ?? "",
          verification,
          reviewerModel,
          specialistInstructions: specialistInstructions.reviewer,
          onRequestBody: websiteProject
            ? (body) => recordModelInput(taskId, "reviewer", reviewerModel, compiledFocus?.sliceId ?? compiledSlice?.sliceId ?? null, [], body)
            : undefined,
        });
        finishRole(activeRoleAssignment, "completed", emit);
        activeRoleAssignment = null;
        const review = freshDecision.review;
        const focusedAcceptance = freshDecision.acceptanceCriteria;
        const reviewHistory = recordCompletedReview(
          task,
          [...(visionReview?.findings ?? []), ...review.findings],
          review.verdict,
          review.summary,
          task.attempts > 0
            ? [`Deterministic verification passed on repair attempt ${task.attempts}.`, "Fresh review run did not reproduce the prior finding."]
            : [],
        );
        emit({ type: "review.history.updated" });
        const reviewedRepository = taskProjectRepository(taskId);
        if (reviewedRepository) for (const finding of review.findings) recordMemoryNote(reviewedRepository, {
          id: `finding:${finding.id}`,
          kind: "finding",
          text: `${finding.severity}: ${finding.title} — ${finding.description}`,
          taskId,
          path: finding.file && access.allowsRepositoryFile(finding.file) ? finding.file : null,
          line: finding.line ?? null,
          createdAt: new Date().toISOString(),
        });
        appendTaskEvent(taskId, "REVIEW_COMPLETED", {
          review,
          status,
          worktreePath: approval.worktreePath,
          model: reviewerModel,
          role: "reviewer",
          attempt: task.attempts,
        });
        emit({ type: "review.completed", review });

        if (freshDecision.action === "repair_current_slice") {
          recordHandoff({
            task,
            fromRole: "reviewer",
            toRole: "implementer",
            objective: task.request,
            evidence: review.findings.map((finding) => `${finding.severity}: ${finding.title} — ${finding.description}`).slice(0, 20),
            openRisks: [review.summary],
            requiredNextAction: "Repair only the blocking findings from independent review.",
          }, emit);
          emit({ type: "stage.updated", stage: "Review", status: "failed" });
          createCheckpointSnapshot(task, "pre_repair");
          const reviewOutcome = workflow.applyReviewOutcome(task, {
            action: "repair",
            reason: freshDecision.reason,
            maximumRepairAttempts: maxRepairAttempts,
          });
          adoptCoreMutation(reviewOutcome);
          if (reviewOutcome.action === "block") {
            appendTaskEvent(taskId, "REPAIR_LIMIT_REACHED", { attempts: task.attempts, review });
            emit({
              type: "stream.blocked",
              message: `Fresh review still found a blocking issue after ${maxRepairAttempts} repair attempts.`,
            });
            return;
          }
          activeRepairContext = null;
          repairEvidence = freshDecision.repairEvidence;
          continue;
        }

        const unresolvedBlocking = blockingReviewFindings(reviewHistory.records);
        if (unresolvedBlocking.length) {
          emit({ type: "stage.updated", stage: "Review", status: "failed" });
          appendTaskEvent(taskId, "DELIVERY_BLOCKED_BY_REVIEW_HISTORY", {
            findingIds: unresolvedBlocking.map((record) => record.id),
          });
          const reviewOutcome = workflow.applyReviewOutcome(task, {
            action: "block",
            reason: `${unresolvedBlocking.length} unresolved high/critical review finding(s) block delivery.`,
            maximumRepairAttempts: maxRepairAttempts,
          });
          adoptCoreMutation(reviewOutcome);
          emit({ type: "stream.blocked", message: `${unresolvedBlocking.length} unresolved high/critical review finding(s) block delivery. Resolve them in Review History.` });
          return;
        }

        if (focusedExecutionScope && projectPlan) {
          const changedPaths = (status.stdout ?? "").split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).trim()).filter((path) => path && !path.includes(" -> "));
          updateVerifiedProjectModel(approvedWorktreePath, changedPaths, focusedAcceptance);
          appendTaskEvent(taskId, "FOCUSED_WORKSPACE_VERIFIED", { scopeType: focusedExecutionScope.type, scopeId: focusedExecutionScope.id, changedPaths });
          status = await tools.execute({ function: { name: "git_status", arguments: {} } }, "agent", taskContext, "verifier", activeDisciplines) as { stdout?: string };
          diff = await tools.execute({ function: { name: "git_diff", arguments: {} } }, "agent", taskContext, "verifier", activeDisciplines) as { stdout?: string };
        }
        if (sliceState && projectPlan) {
          const summary = `Verified ${currentSlice(projectPlan, sliceState).title}.\n\nChanged files:\n${(status.stdout ?? "").slice(0, 1200)}\n\nVerification: passed.\n\nReview: ${review.summary.slice(0, 1200)}`;
          const changedPaths = (status.stdout ?? "").split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).trim()).filter((path) => path && !path.includes(" -> "));
          updateVerifiedProjectModel(approvedWorktreePath, changedPaths, currentSlice(projectPlan, sliceState).acceptanceCriteria);
          const ready = markSliceReady(approvedWorktreePath, taskId, summary, { plan: projectPlan, state: sliceState });
          if (ready) appendTaskEvent(taskId, "FRONTEND_SLICE_READY", { slice: ready.current, status: ready.status });
          status = await tools.execute({ function: { name: "git_status", arguments: {} } }, "agent", taskContext, "verifier", activeDisciplines) as { stdout?: string };
          diff = await tools.execute({ function: { name: "git_diff", arguments: {} } }, "agent", taskContext, "verifier", activeDisciplines) as { stdout?: string };
        }
        appendTaskEvent(taskId, "CHANGESET_CAPTURED", { status: status.stdout ?? "", diff: diff.stdout ?? "" });
        emit({ type: "implementation.summary", status, diff, worktreePath: approval.worktreePath });
        emit({ type: "stage.updated", stage: "Review", status: "complete" });
        const reviewOutcome = workflow.applyReviewOutcome(task, {
          action: "pass",
          reason: "Fresh review passed with no unresolved blocking findings.",
          maximumRepairAttempts: maxRepairAttempts,
        });
        adoptCoreMutation(reviewOutcome, "pre_delivery");
        appendTaskEvent(taskId, "DELIVERY_READY", { worktreePath: approval.worktreePath });
        emit({ type: "delivery.ready", worktreePath: approval.worktreePath, message: "Verified and independently reviewed. Choose how to deliver the isolated changes." });
        emit({ type: "stream.completed" });
        
        return;
      }

    } catch (error) {

      if (activeRoleAssignment?.status === "active") finishRole(activeRoleAssignment, "failed", emit);
      await Promise.allSettled([
        tools.execute({ function: { name: "browser_close", arguments: {} } }, "agent", taskContext),
      ]);
      const message = error instanceof Error ? error.message : "Approved implementation failed";
      if (tasks.listEvents(taskId).some((event) => event.type === "FRONTEND_SLICE_SELECTED") && websiteInfo(approvedWorktreePath) && readSliceState(approvedWorktreePath)) {
        const failedSlice = readSliceState(approvedWorktreePath)!;
        setFrontendWorkflowStage(approvedWorktreePath, "blocked", { currentSlice: failedSlice.current, totalSlices: failedSlice.total, taskId, detail: message });
      }
      appendTaskEvent(taskId, "IMPLEMENTATION_FAILED", { message });
      if (task && !["CANCELLED", "COMPLETE"].includes(task.state)) {
        adoptCoreMutation(workflow.applyExecutionFailure(task, message));
      }
      emit({ type: "runtime.failed", message });
      

    }
  }
}
