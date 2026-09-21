import type { BrowserEvidenceReport } from "../../../packages/browser-verification/src/index.ts";
import type { Finding } from "../../../packages/core/src/contracts.ts";
import type { VisionReviewResult, VisionReviewService } from "../../../packages/vision-review/src/index.ts";
import type {
  DesignBrief,
  DesignReviewResult,
  VisualDirectorService,
} from "../../../packages/design-intelligence/src/index.ts";
import type { ProjectPlan, SliceState } from "../../../packages/web-builder/src/slice-docs.ts";
import { runFreshReview, type FreshReview } from "./fresh-review.ts";
import type { FocusedScope } from "./task-scope-resolver.ts";

export type QualityEventSink = (event: Record<string, unknown>) => void;
export type QualityTaskEventSink = (type: string, payload: Record<string, unknown>) => void;

export type VisualQualityDecision =
  | {
      action: "pass";
      visionReview: VisionReviewResult | null;
      designReview: DesignReviewResult | null;
    }
  | {
      action: "repair_current_slice";
      source: "local_vision" | "visual_director";
      reason: string;
      repairEvidence: string;
      findings: Finding[];
      visionReview: VisionReviewResult | null;
      designReview: DesignReviewResult | null;
    }
  | {
      action: "revise_project_plan";
      scope: "cross_slice" | "project_plan";
      reason: string;
      designReview: DesignReviewResult;
      visionReview: VisionReviewResult | null;
    }
  | {
      action: "block";
      source: "visual_director";
      reason: string;
      designReview: DesignReviewResult | null;
      visionReview: VisionReviewResult | null;
    };

export type FreshReviewDecision =
  | {
      action: "pass";
      review: FreshReview;
      acceptanceCriteria: string[];
    }
  | {
      action: "repair_current_slice";
      source: "fresh_review";
      reason: string;
      repairEvidence: string;
      findings: Finding[];
      review: FreshReview;
      acceptanceCriteria: string[];
    };

export type QualityGateServiceDependencies = {
  vision: VisionReviewService;
  visualDirector: VisualDirectorService;
  ollamaUrl: string;
  runReview: typeof runFreshReview;
};

export class QualityGateService {
  private readonly deps: QualityGateServiceDependencies;

  constructor(deps: QualityGateServiceDependencies) {
    this.deps = deps;
  }

  async evaluateVisual(input: {
    taskId: string;
    request: string;
    worktreePath: string;
    browserEvidence: BrowserEvidenceReport | null | undefined;
    designBrief: DesignBrief | null;
    activeSlicePrompt: string;
    projectPlan: ProjectPlan | null;
    sliceState: SliceState | null;
    attempt: number;
    emit: QualityEventSink;
    appendTaskEvent: QualityTaskEventSink;
    onVisionRequestBody?: (body: string) => void;
    onDesignRequestBody?: (body: string) => void;
  }): Promise<VisualQualityDecision> {
    let visionReview: VisionReviewResult | null = null;

    if (input.browserEvidence && !input.designBrief) {
      const status = this.deps.vision.status();
      input.appendTaskEvent("VISION_REVIEW_STARTED", {
        provider: status.provider,
        model: status.model,
        attempt: input.attempt,
      });
      input.emit({ type: "vision.review.started", provider: status.provider, model: status.model });
      visionReview = await this.deps.vision.review({
        taskId: input.taskId,
        request: input.request,
        worktreePath: input.worktreePath,
        browserEvidence: input.browserEvidence,
        onRequestBody: input.onVisionRequestBody,
      });
      const visionEvent = visionReview.status === "unavailable" ? "VISION_REVIEW_UNAVAILABLE"
        : visionReview.status === "failed" ? "VISION_REVIEW_FAILED"
        : visionReview.status === "inconclusive" ? "VISION_REVIEW_INCONCLUSIVE"
        : visionReview.status === "disabled" ? "VISION_REVIEW_DISABLED"
        : "VISION_REVIEW_COMPLETED";
      input.appendTaskEvent(visionEvent, { review: visionReview, attempt: input.attempt });
      input.emit({ type: "vision.review.completed", visionReview });

      if (visionReview.status === "repair") {
        return {
          action: "repair_current_slice",
          source: "local_vision",
          reason: "Local vision review found a blocking visual defect.",
          repairEvidence: `Local vision review requires repair:\n${JSON.stringify(visionReview).slice(0, 60_000)}`,
          findings: visionReview.findings,
          visionReview,
          designReview: null,
        };
      }
    }

    if (!input.designBrief) {
      return { action: "pass", visionReview, designReview: null };
    }

    if (!input.browserEvidence) {
      input.appendTaskEvent("DESIGN_REVIEW_BLOCKED", {
        reason: "Missing browser evidence.",
        attempt: input.attempt,
      });
      return {
        action: "block",
        source: "visual_director",
        reason: "Design quality could not be verified because responsive browser evidence is missing.",
        designReview: null,
        visionReview,
      };
    }

    const policy = this.deps.vision.status();
    input.emit({ type: "stage.updated", stage: "Visual Direction", status: "active" });
    input.appendTaskEvent("DESIGN_REVIEW_STARTED", {
      provider: policy.provider,
      model: policy.model,
      attempt: input.attempt,
    });
    input.emit({ type: "design.review.started", provider: policy.provider, model: policy.model });
    const currentSlice = input.sliceState && input.projectPlan
      ? input.projectPlan.slices[input.sliceState.current] ?? null
      : null;
    const designReview = await this.deps.visualDirector.review({
      taskId: input.taskId,
      request: [input.request, input.activeSlicePrompt].filter(Boolean).join("\n\n"),
      worktreePath: input.worktreePath,
      browserEvidence: input.browserEvidence,
      brief: input.designBrief,
      policy,
      scope: {
        currentSlice: currentSlice ? {
          id: currentSlice.id,
          title: currentSlice.title,
          outcome: currentSlice.outcome,
          scope: currentSlice.scope,
        } : null,
        projectPages: input.projectPlan?.sitemap.map((page) => ({
          id: page.id,
          name: page.name,
          route: page.route,
        })) ?? [],
      },
      onRequestBody: input.onDesignRequestBody,
    });
    input.appendTaskEvent(
      designReview.status === "pass" || designReview.status === "repair"
        ? "DESIGN_REVIEW_COMPLETED"
        : "DESIGN_REVIEW_BLOCKED",
      { review: designReview, attempt: input.attempt },
    );
    input.emit({ type: "design.review.completed", designReview });

    if (designReview.status === "repair") {
      const reason = designReview.scopeReason || designReview.summary;
      if (designReview.repairScope === "cross_slice" || designReview.repairScope === "project_plan") {
        return {
          action: "revise_project_plan",
          scope: designReview.repairScope,
          reason,
          designReview,
          visionReview,
        };
      }
      return {
        action: "repair_current_slice",
        source: "visual_director",
        reason: designReview.summary,
        repairEvidence: this.currentSliceDesignRepairEvidence(designReview),
        findings: designReview.findings,
        designReview,
        visionReview,
      };
    }

    if (designReview.status !== "pass") {
      return {
        action: "block",
        source: "visual_director",
        reason: `Premium frontend delivery is blocked because mandatory aesthetic review is ${designReview.status}: ${designReview.summary}`,
        designReview,
        visionReview,
      };
    }

    input.emit({ type: "stage.updated", stage: "Visual Direction", status: "complete" });
    return { action: "pass", visionReview, designReview };
  }

  async evaluateFreshReview(input: {
    taskId: string;
    request: string;
    projectPlan: ProjectPlan | null;
    sliceState: SliceState | null;
    focusedScope: FocusedScope | null;
    styleWorkspace: boolean;
    implementationBudgetExhausted: boolean;
    diff: string;
    verification: unknown;
    reviewerModel: string;
    specialistInstructions: string;
    onRequestBody?: (body: string) => void;
  }): Promise<FreshReviewDecision> {
    const activeSlice = input.sliceState && input.projectPlan
      ? input.projectPlan.slices[input.sliceState.current] ?? null
      : null;
    const acceptanceCriteria = this.acceptanceCriteria({
      projectPlan: input.projectPlan,
      activeSlice,
      focusedScope: input.focusedScope,
      styleWorkspace: input.styleWorkspace,
    });

    const review = await this.deps.runReview({
      ollamaUrl: this.deps.ollamaUrl,
      model: input.reviewerModel,
      taskId: input.taskId,
      request: input.request,
      projectGoal: input.projectPlan?.siteGoal,
      sliceTitle: activeSlice?.title,
      sliceOutcome: activeSlice?.outcome,
      acceptanceCriteria,
      implementationBudgetExhausted: input.implementationBudgetExhausted,
      diff: input.diff,
      verification: input.verification,
      specialistInstructions: input.specialistInstructions,
      onRequestBody: input.onRequestBody,
    });

    if (review.verdict === "repair") {
      return {
        action: "repair_current_slice",
        source: "fresh_review",
        reason: "Fresh-context review found a blocking issue.",
        repairEvidence: `Fresh-context review requires repair:\n${JSON.stringify(review).slice(0, 60_000)}`,
        findings: review.findings,
        review,
        acceptanceCriteria,
      };
    }

    return { action: "pass", review, acceptanceCriteria };
  }

  private acceptanceCriteria(input: {
    projectPlan: ProjectPlan | null;
    activeSlice: ProjectPlan["slices"][number] | null;
    focusedScope: FocusedScope | null;
    styleWorkspace: boolean;
  }): string[] {
    if (input.focusedScope && input.projectPlan) {
      const focused = input.focusedScope.type === "page"
        ? input.projectPlan.sitemap.find((page) => page.id === input.focusedScope!.id)
        : input.projectPlan.components.find((component) => component.id === input.focusedScope!.id);
      if (focused?.acceptanceCriteria.length) return focused.acceptanceCriteria;
    }

    if (input.styleWorkspace && input.projectPlan?.styles) {
      return [
        input.projectPlan.styles.direction,
        ...input.projectPlan.styles.layoutPrinciples,
        ...input.projectPlan.styles.responsive,
        ...input.projectPlan.styles.accessibility,
        ...input.projectPlan.styles.avoid.map((item) => `Avoid: ${item}`),
      ];
    }

    return input.activeSlice?.acceptanceCriteria ?? input.projectPlan?.acceptanceCriteria ?? [];
  }

  private currentSliceDesignRepairEvidence(review: DesignReviewResult): string {
    return `VISUAL DIRECTOR CURRENT-SLICE REFINEMENT REQUIRED. The Visual Director explicitly classified this repair as legal inside the current approved slice. Rework the design against the persisted Design Brief and screenshot evidence while preserving working behavior, then recapture responsive browser evidence.

Structured scope decision:
- repairScope: ${review.repairScope}
- scopeReason: ${review.scopeReason}

Work from the authoritative repair grounding that BORG injects automatically:
- Start from the supplied changed-file list, current source diff, changed-file contents, and direct dependencies. Do not guess paths, components, or CSS selectors.
- Read only further direct dependencies when necessary to repair an implicated file.
- Trace every style change to markup that actually uses it.
- Address the highest-severity visible findings with a material composition change, not small token or spacing adjustments.
- Do not broaden beyond the current slice; a wider change requires a new plan-revision classification.
- Capture mobile, tablet, and desktop evidence after editing and inspect whether the cited visual problem visibly changed before finishing.

${JSON.stringify(review).slice(0, 70_000)}`;
  }
}
