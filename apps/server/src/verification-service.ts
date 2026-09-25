import { createHash, randomUUID } from "node:crypto";
import type { EngineeringDiscipline, Finding } from "../../../packages/core/src/contracts.ts";
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

function boundedEvidence(value: string, maximum = 4_000): string {
  return value.trim().slice(0, maximum);
}

function issueIdentity(issue: string): { category: string; title: string; remediation: string } {
  const normalized = issue.toLowerCase();
  if (normalized.includes("accessibility")) return {
    category: "verification/accessibility",
    title: "Accessibility verification failed",
    remediation: "Fix every reported accessibility violation, then rerun browser verification at all required viewports.",
  };
  if (normalized.includes("button") || normalized.includes("control") || normalized.includes("action")) return {
    category: "verification/interaction",
    title: "An enabled control does not complete its action",
    remediation: "Connect each enabled control to a working interaction and verify the resulting state or navigation in the browser.",
  };
  if (normalized.includes("link") || normalized.includes("href") || normalized.includes("route")) return {
    category: "verification/navigation",
    title: "Navigation verification failed",
    remediation: "Give every visible navigation element a meaningful destination and verify the target route renders.",
  };
  return {
    category: "verification/browser",
    title: "Browser verification failed",
    remediation: "Repair the reported browser behavior and rerun the same verification check.",
  };
}

export function findingsFromVerification(taskId: string, verification: VerificationOutcome): Finding[] {
  const findings: Finding[] = [];
  const accessibility = verification.browserEvidence?.accessibility;
  for (const violation of accessibility?.violations ?? []) {
    const nodes = violation.nodes.slice(0, 8).map((node) => [
      node.target.join(" "),
      node.failureSummary,
    ].filter(Boolean).join(": ")).join("\n");
    findings.push({
      id: randomUUID(), taskId, discipline: "frontend",
      severity: violation.impact === "critical" ? "critical" : violation.impact === "serious" ? "high" : "medium",
      category: `verification/accessibility/${violation.id}`,
      title: `Accessibility: ${violation.help}`,
      description: `${violation.nodes.length} element${violation.nodes.length === 1 ? "" : "s"} failed the ${violation.id} accessibility rule.`,
      evidence: boundedEvidence(nodes || violation.helpUrl),
      remediation: `Resolve the ${violation.id} rule on every listed element, then rerun accessibility verification. ${violation.helpUrl}`,
      confidence: 1,
    });
  }

  for (const issue of verification.browserEvidence?.issues ?? []) {
    if (accessibility?.violations.length && issue.toLowerCase().includes("accessibility")) continue;
    const identity = issueIdentity(issue);
    findings.push({
      id: randomUUID(), taskId, discipline: "frontend", severity: "high",
      ...identity, description: issue, evidence: issue, confidence: 1,
    });
  }

  for (const result of verification.results ?? []) {
    if (result.exitCode === undefined || result.exitCode === 0) continue;
    const label = result.label || result.command || "Project check";
    findings.push({
      id: randomUUID(), taskId, discipline: "generalist", severity: "high",
      category: `verification/command/${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      title: `${label} failed`,
      description: `The ${label} verification command exited with code ${result.exitCode}.`,
      evidence: boundedEvidence([result.stderr, result.stdout].filter(Boolean).join("\n") || "No command output was captured."),
      remediation: `Fix the reported ${label} errors and rerun deterministic verification.`,
      confidence: 1,
    });
  }

  for (const failure of verification.specialistEvidence.failures ?? []) {
    findings.push({
      id: randomUUID(), taskId, discipline: "generalist", severity: "high",
      category: "verification/specialist", title: "Specialist verification failed",
      description: failure, evidence: failure,
      remediation: "Address the specialist requirement described here and rerun verification.", confidence: 1,
    });
  }

  if (verification.focusedBrowserFailure) findings.push({
    id: randomUUID(), taskId, discipline: "frontend", severity: "high",
    category: "verification/focused-route", title: "Focused route verification could not complete",
    description: verification.focusedBrowserFailure, evidence: verification.focusedBrowserFailure,
    remediation: "Restore the managed development server and verify the focused route before continuing.", confidence: 1,
  });

  if (!findings.length && !verification.passed) findings.push({
    id: randomUUID(), taskId, discipline: "generalist", severity: "high",
    category: "verification/unknown", title: "Deterministic verification failed",
    description: "Verification did not pass, but no more specific failure was captured.",
    remediation: "Inspect the verification logs, repair the failing check, and rerun verification.", confidence: 0.7,
  });
  return findings;
}

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
