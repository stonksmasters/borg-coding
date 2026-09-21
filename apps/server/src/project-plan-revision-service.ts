import type { EngineeringDiscipline } from "../../../packages/core/src/contracts.ts";
import type { ToolBroker } from "../../../packages/tools/src/tool-broker.ts";
import {
  parseProjectPlanResult,
  persistProposedProjectPlan,
  projectPlanDelta,
  projectPlanRepairPrompt,
  projectPlanRevisionPrompt,
  validateProjectPlanCoverage,
  type PlanCoverageReport,
  type ProjectPlan,
  type ProjectPlanDelta,
  type ProjectPlanValidation,
} from "../../../packages/web-builder/src/slice-docs.ts";
import type { DesignReviewResult } from "../../../packages/design-intelligence/src/index.ts";
import { runOllamaAgent } from "./ollama-agent.ts";

export type ProjectPlanRevisionEventSink = (event: Record<string, unknown>) => void;

export type ProjectPlanRevisionInput = {
  taskId: string;
  brief: string;
  currentPlan: ProjectPlan;
  currentSliceIndex: number;
  conflictReason: string;
  review: DesignReviewResult;
  template: string;
  model: string;
  tools: ToolBroker;
  disciplines: readonly EngineeringDiscipline[];
  emit: ProjectPlanRevisionEventSink;
  onRequestBody?: (body: string) => void;
};

export type ProjectPlanRevisionGeneration =
  | {
      status: "candidate";
      candidate: ProjectPlan;
      answer: string;
      usedTools: boolean;
      validation: ProjectPlanValidation;
      semanticRetryUsed: boolean;
    }
  | {
      status: "invalid";
      reason: string;
      answer: string;
      usedTools: boolean;
      validation: ProjectPlanValidation;
      semanticRetryUsed: boolean;
    };

export type ProjectPlanRevisionProjection = {
  plan: ProjectPlan;
  coverage: PlanCoverageReport;
  delta: ProjectPlanDelta;
};

export type ProjectPlanRevisionServiceDependencies = {
  ollamaUrl: string;
  runAgent: typeof runOllamaAgent;
};

export class ProjectPlanRevisionService {
  private readonly deps: ProjectPlanRevisionServiceDependencies;

  constructor(deps: ProjectPlanRevisionServiceDependencies) {
    this.deps = deps;
  }

  async generate(input: ProjectPlanRevisionInput): Promise<ProjectPlanRevisionGeneration> {
    const revisionRequest = {
      ollamaUrl: this.deps.ollamaUrl,
      model: input.model,
      tools: input.tools,
      mode: "plan" as const,
      role: "architect" as const,
      disciplines: input.disciplines,
      phase: "plan" as const,
      emit: input.emit,
      limits: { toolRounds: 3, toolCalls: 4 },
      onRequestBody: input.onRequestBody,
      messages: [
        {
          role: "system" as const,
          content: "You are BORG's bounded project-plan repair architect. Revise planning authority only. Do not mutate source, run commands, restart repository discovery, or discard already-completed work. The original brief, durable current plan, active slice, and independent review evidence below are authoritative.",
        },
        {
          role: "user" as const,
          content: projectPlanRevisionPrompt({
            brief: input.brief,
            currentPlan: input.currentPlan,
            currentSliceIndex: input.currentSliceIndex,
            conflictReason: input.conflictReason,
            review: input.review,
          }),
        },
      ],
    };

    let result = await this.deps.runAgent(revisionRequest);
    let parsed = parseProjectPlanResult(result.answer, input.brief, input.template);
    let semanticRetryUsed = false;

    if (parsed.source === "fallback") {
      semanticRetryUsed = true;
      input.emit({
        type: "project.plan.revision.semantic_retry",
        reason: parsed.fallbackReason,
        validation: parsed.validation,
      });
      result = await this.deps.runAgent({
        ...revisionRequest,
        messages: [
          ...revisionRequest.messages,
          { role: "assistant" as const, content: result.answer },
          { role: "user" as const, content: projectPlanRepairPrompt(parsed) },
        ],
        limits: { toolRounds: 2, toolCalls: 2 },
      });
      parsed = parseProjectPlanResult(result.answer, input.brief, input.template);
    }

    if (parsed.source === "fallback" || !parsed.validation.valid) {
      return {
        status: "invalid",
        reason: `Plan revision failed semantic validation: ${parsed.fallbackReason ?? parsed.validation.issues.join(" ")}`,
        answer: result.answer,
        usedTools: result.usedTools,
        validation: parsed.validation,
        semanticRetryUsed,
      };
    }

    return {
      status: "candidate",
      candidate: parsed.plan,
      answer: result.answer,
      usedTools: result.usedTools,
      validation: parsed.validation,
      semanticRetryUsed,
    };
  }

  persistAuthoritativeProjection(input: {
    root: string;
    taskId: string;
    brief: string;
    previousPlan: ProjectPlan;
    authoritativePlan: ProjectPlan;
    resumeSliceIndex: number;
    revisionReason: string;
  }): ProjectPlanRevisionProjection {
    const coverage = validateProjectPlanCoverage(input.authoritativePlan, input.brief);
    if (!coverage.valid) {
      throw new Error(`Core plan revision failed coverage after parse validation: ${coverage.issues.join(" ")}`);
    }
    const delta = projectPlanDelta(input.previousPlan, input.authoritativePlan);
    persistProposedProjectPlan(input.root, input.brief, input.authoritativePlan, input.taskId, {
      coverage,
      currentSlice: input.resumeSliceIndex,
      revisionReason: input.revisionReason,
    });
    return { plan: input.authoritativePlan, coverage, delta };
  }
}
