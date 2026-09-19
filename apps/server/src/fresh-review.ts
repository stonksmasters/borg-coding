import { randomUUID } from "node:crypto";
import { FindingSchema, type Finding } from "../../../packages/core/src/contracts.ts";

export interface ReviewCriterion {
  criterion: string;
  verdict: "pass" | "fail" | "not_proven";
  evidence: string;
}

export interface FreshReview {
  verdict: "pass" | "repair";
  summary: string;
  criteria: ReviewCriterion[];
  findings: Finding[];
}

function extractJson(value: string): unknown {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(trimmed);
}

function normalizeCriterion(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function parseFreshReview(taskId: string, value: string, requiredCriteria: string[] = []): FreshReview {
  const parsed = extractJson(value) as { verdict?: unknown; summary?: unknown; criteria?: unknown; findings?: unknown };
  if (parsed.verdict !== "pass" && parsed.verdict !== "repair") throw new Error("Reviewer returned an invalid verdict.");
  if (typeof parsed.summary !== "string" || !parsed.summary.trim()) throw new Error("Reviewer returned no summary.");
  if (!Array.isArray(parsed.findings)) throw new Error("Reviewer returned invalid findings.");

  const returnedCriteria = Array.isArray(parsed.criteria)
    ? parsed.criteria.slice(0, 40).flatMap((raw): ReviewCriterion[] => {
        const item = raw as Record<string, unknown>;
        const criterion = typeof item.criterion === "string" ? item.criterion.trim() : "";
        const verdict = item.verdict;
        const evidence = typeof item.evidence === "string" ? item.evidence.trim() : "";
        if (!criterion || !["pass", "fail", "not_proven"].includes(String(verdict))) return [];
        return [{ criterion, verdict: verdict as ReviewCriterion["verdict"], evidence: evidence || "No evidence supplied." }];
      })
    : [];
  const byCriterion = new Map(returnedCriteria.map((item) => [normalizeCriterion(item.criterion), item]));
  const criteria = requiredCriteria.length
    ? requiredCriteria.map((criterion) => byCriterion.get(normalizeCriterion(criterion)) ?? {
        criterion,
        verdict: "not_proven" as const,
        evidence: "The reviewer did not provide evidence for this required acceptance criterion.",
      })
    : returnedCriteria;

  const findings = parsed.findings.slice(0, 20).map((raw) => {
    const item = raw as Record<string, unknown>;
    return FindingSchema.parse({
      id: randomUUID(), taskId, discipline: String(item.discipline ?? "general"),
      severity: item.severity, category: String(item.category ?? "correctness"),
      title: item.title, description: item.description,
      ...(typeof item.file === "string" && item.file ? { file: item.file } : {}),
      ...(Number.isInteger(item.line) && Number(item.line) > 0 ? { line: Number(item.line) } : {}),
      ...(typeof item.evidence === "string" && item.evidence ? { evidence: item.evidence } : {}),
      ...(typeof item.remediation === "string" && item.remediation ? { remediation: item.remediation } : {}),
    });
  });
  const hasBlockingFinding = findings.some((finding) => finding.severity === "high" || finding.severity === "critical");
  const hasUnprovenCriterion = criteria.some((criterion) => criterion.verdict !== "pass");
  return {
    verdict: parsed.verdict === "repair" || hasBlockingFinding || hasUnprovenCriterion ? "repair" : "pass",
    summary: parsed.summary.trim(),
    criteria,
    findings,
  };
}

export async function runFreshReview(options: {
  ollamaUrl: string;
  model: string;
  taskId: string;
  request: string;
  projectGoal?: string;
  sliceTitle?: string;
  sliceOutcome?: string;
  acceptanceCriteria?: string[];
  implementationBudgetExhausted?: boolean;
  diff: string;
  verification: unknown;
  specialistInstructions?: string;
  onRequestBody?: (body: string) => void;
}): Promise<FreshReview> {
  const criteria = (options.acceptanceCriteria ?? []).filter(Boolean).slice(0, 30);
  const reviewContract = [
    options.projectGoal ? `Project goal: ${options.projectGoal}` : "",
    options.sliceTitle ? `Current slice: ${options.sliceTitle}` : "",
    options.sliceOutcome ? `Required outcome: ${options.sliceOutcome}` : "",
    criteria.length ? `Acceptance criteria:\n${criteria.map((criterion, index) => `${index + 1}. ${criterion}`).join("\n")}` : "",
    options.implementationBudgetExhausted
      ? "Implementation exhausted its bounded tool budget. Treat completeness as unproven unless the supplied diff and verification evidence independently prove every required criterion."
      : "",
  ].filter(Boolean).join("\n\n");

  const requestBody = JSON.stringify({
    model: options.model,
    stream: false,
    format: "json",
    messages: [
      {
        role: "system",
        content: `You are BORG's fresh-context code reviewer. You did not implement this change. Review only the supplied product contract, request, verified diff, and verification evidence.

For every supplied acceptance criterion, return one criteria entry using the criterion text exactly, verdict ('pass', 'fail', or 'not_proven'), and concrete evidence. A required criterion is pass only when the supplied diff or verification evidence proves it. Missing evidence is not_proven. Any fail or not_proven criterion requires the overall verdict to be repair.

Also review correctness, regressions, security, data loss, and maintainability. Return strict JSON with verdict ('pass' or 'repair'), summary, criteria, and findings. Each finding must contain discipline, severity (info, low, medium, high, or critical), category, title, description, and optional file, line, evidence, remediation. Do not invent evidence.

Active specialist capability packs:
${options.specialistInstructions ?? "General review policy applies."}`,
      },
      {
        role: "user",
        content: `Product/slice contract:
${reviewContract || "No additional structured acceptance contract was supplied."}

Original request:
${options.request.slice(0, 8_000)}

Verification evidence:
${JSON.stringify(options.verification).slice(0, 16_000)}

Verified Git diff:
${options.diff.slice(0, 30_000)}${options.diff.length > 30_000 ? "\n[Diff truncated; report that the review covers only the visible portion.]" : ""}`,
      },
    ],
  });
  options.onRequestBody?.(requestBody);
  const response = await fetch(`${options.ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: requestBody,
    signal: AbortSignal.timeout(Math.max(60_000, Math.min(900_000, Number(process.env.BORG_REVIEW_TIMEOUT_MS ?? 600_000)))),
  });
  if (!response.ok) throw new Error(`Fresh review failed (${response.status}).`);
  const body = await response.json() as { message?: { content?: string }; error?: string };
  if (body.error) throw new Error(body.error);
  return parseFreshReview(options.taskId, body.message?.content ?? "", criteria);
}
