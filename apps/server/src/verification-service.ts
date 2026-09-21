import { createHash } from "node:crypto";
import type { EngineeringDiscipline } from "../../../packages/core/src/contracts.ts";
import type { BrowserEvidenceReport } from "../../../packages/browser-verification/src/index.ts";
import {
  evaluateSpecialistEvidence,
  type SpecialistCapabilityPack,
} from "../../../packages/orchestration/src/index.ts";
import type { ProcessRuntime } from "../../../packages/process-runtime/src/index.ts";
import type { ToolBroker } from "../../../packages/tools/src/tool-broker.ts";
import type { TaskToolContext } from "../../../packages/tools/src/worktree-tools.ts";
import type { FocusedScope } from "./task-scope-resolver.ts";

export type DeterministicVerificationResult = {
  passed?: boolean;
  results?: Array<{
    label?: string;
    command?: string;
    args?: string[];
    exitCode?: number;
    stdout?: string;
    stderr?: string;
  }>;
  browserEvidence?: BrowserEvidenceReport | null;
  visualRegression?: {
    status?: string;
    passed?: boolean;
    [key: string]: unknown;
  };
};

export type VerificationOutcome = DeterministicVerificationResult & {
  browserEvidence?: BrowserEvidenceReport | null;
  focusedBrowserRoute: string | null;
  focusedBrowserFailure: string | null;
  passed: boolean;
  specialistEvidence: ReturnType<typeof evaluateSpecialistEvidence>;
  specialistInstructions: string;
};

export type VerificationServiceInput = {
  taskId: string;
  taskContext: TaskToolContext;
  activeDisciplines: readonly EngineeringDiscipline[];
  packs: readonly SpecialistCapabilityPack[];
  verificationProfile: "quick" | "full";
  specialistInstructions: string;
  focusedScope: FocusedScope | null;
  focusedBrowserRoute: string | null;
};

export type VerificationServiceResult = {
  deterministic: DeterministicVerificationResult;
  verification: VerificationOutcome;
  failure: string;
  summary: string;
  resultSha256: string;
};

export type VerificationEventSink = (event: Record<string, unknown>) => void;
export type VerificationTaskEventSink = (type: string, payload: Record<string, unknown>) => void;

export type VerificationServiceDependencies = {
  tools: ToolBroker;
  processRuntime: ProcessRuntime;
};

export class VerificationService {
  private readonly deps: VerificationServiceDependencies;

  constructor(deps: VerificationServiceDependencies) {
    this.deps = deps;
  }

  async run(
    input: VerificationServiceInput,
    emit: VerificationEventSink,
    appendTaskEvent: VerificationTaskEventSink,
    attempt: number,
  ): Promise<VerificationServiceResult> {
    const {
      taskId,
      taskContext,
      activeDisciplines,
      packs,
      verificationProfile,
      specialistInstructions,
      focusedScope,
      focusedBrowserRoute,
    } = input;

    emit({ type: "tool.started", tool: "verification_run", input: { profile: verificationProfile } });

    const deterministic = await this.deps.tools.execute(
      { function: { name: "verification_run", arguments: { profile: verificationProfile } } },
      "agent",
      taskContext,
      "verifier",
      activeDisciplines,
    ) as DeterministicVerificationResult;

    let focusedBrowserEvidence: BrowserEvidenceReport | null = null;
    let focusedBrowserFailure: string | null = null;

    if (focusedBrowserRoute) {
      const serverUrl = this.deps.processRuntime.findRunning(taskId, "dev_server")?.url;
      if (!serverUrl) {
        focusedBrowserFailure = "Focused route verification requires the managed development server.";
      } else {
        const focusedUrl = new URL(focusedBrowserRoute, serverUrl).toString();
        try {
          await this.deps.tools.execute(
            { function: { name: "browser_responsive", arguments: { url: focusedUrl, accessibility: true } } },
            "agent",
            taskContext,
            "verifier",
            activeDisciplines,
          );
          const closed = await this.deps.tools.execute(
            { function: { name: "browser_close", arguments: {} } },
            "agent",
            taskContext,
            "verifier",
            activeDisciplines,
          ) as { report?: BrowserEvidenceReport | null };
          focusedBrowserEvidence = closed.report ?? null;
          appendTaskEvent("FOCUSED_BROWSER_VERIFICATION_COMPLETED", {
            scope: focusedScope,
            route: focusedBrowserRoute,
            passed: focusedBrowserEvidence?.passed ?? false,
          });
        } catch (error) {
          focusedBrowserFailure = error instanceof Error ? error.message : String(error);
          appendTaskEvent("FOCUSED_BROWSER_VERIFICATION_FAILED", {
            scope: focusedScope,
            route: focusedBrowserRoute,
            message: focusedBrowserFailure,
          });
        }
      }
    }

    const verificationEvidence = focusedBrowserEvidence
      ? { ...deterministic, browserEvidence: focusedBrowserEvidence }
      : deterministic;
    const specialistEvidence = evaluateSpecialistEvidence(packs, verificationEvidence);
    const verification: VerificationOutcome = {
      ...deterministic,
      browserEvidence: focusedBrowserEvidence ?? deterministic.browserEvidence,
      focusedBrowserRoute,
      focusedBrowserFailure,
      passed: Boolean(deterministic.passed)
        && !focusedBrowserFailure
        && (focusedBrowserEvidence?.passed ?? true)
        && specialistEvidence.passed,
      specialistEvidence,
      specialistInstructions,
    };

    emit({ type: "tool.completed", tool: "verification_run", output: verification });

    const failure = [
      ...(verification.browserEvidence?.issues ?? []),
      ...(verification.specialistEvidence?.failures ?? []),
    ].filter(Boolean).join(" ") || "Deterministic verification failed.";

    const summary = verification.passed
      ? `${verificationProfile} verification passed for repair attempt ${attempt}.`
      : failure;

    return {
      deterministic,
      verification,
      failure,
      summary,
      resultSha256: createHash("sha256").update(JSON.stringify(verification)).digest("hex"),
    };
  }
}
