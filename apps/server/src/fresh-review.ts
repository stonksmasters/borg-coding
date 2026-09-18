import { randomUUID } from "node:crypto";
import { FindingSchema, type Finding } from "../../../packages/core/src/contracts.ts";

export interface FreshReview {
  verdict: "pass" | "repair";
  summary: string;
  findings: Finding[];
}

function extractJson(value: string): unknown {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(trimmed);
}

export function parseFreshReview(taskId: string, value: string): FreshReview {
  const parsed = extractJson(value) as { verdict?: unknown; summary?: unknown; findings?: unknown };
  if (parsed.verdict !== "pass" && parsed.verdict !== "repair") throw new Error("Reviewer returned an invalid verdict.");
  if (typeof parsed.summary !== "string" || !parsed.summary.trim()) throw new Error("Reviewer returned no summary.");
  if (!Array.isArray(parsed.findings)) throw new Error("Reviewer returned invalid findings.");
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
  return { verdict: parsed.verdict === "repair" || hasBlockingFinding ? "repair" : "pass", summary: parsed.summary.trim(), findings };
}

export async function runFreshReview(options: {
  ollamaUrl: string; model: string; taskId: string; request: string;
  diff: string; verification: unknown; specialistInstructions?: string;
}): Promise<FreshReview> {
  const response = await fetch(`${options.ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: options.model, stream: false, format: "json",
      messages: [
        { role: "system", content: `You are BORG's fresh-context code reviewer. You did not implement this change. Review only the supplied request, verified diff, and verification evidence. Return strict JSON with verdict ('pass' or 'repair'), summary, and findings. Each finding must contain discipline, severity (info, low, medium, high, or critical), category, title, description, and optional file, line, evidence, remediation. Use repair only for high or critical correctness, security, data-loss, or requirement failures. Do not invent evidence.\n\nActive specialist capability packs:\n${options.specialistInstructions ?? "General review policy applies."}` },
        { role: "user", content: `Original request:\n${options.request.slice(0, 8_000)}\n\nVerification evidence:\n${JSON.stringify(options.verification).slice(0, 12_000)}\n\nVerified Git diff:\n${options.diff.slice(0, 30_000)}${options.diff.length > 30_000 ? "\n[Diff truncated; report that the review covers only the visible portion.]" : ""}` },
      ],
    }),
    signal: AbortSignal.timeout(Math.max(60_000, Math.min(900_000, Number(process.env.BORG_REVIEW_TIMEOUT_MS ?? 600_000)))),
  });
  if (!response.ok) throw new Error(`Fresh review failed (${response.status}).`);
  const body = await response.json() as { message?: { content?: string }; error?: string };
  if (body.error) throw new Error(body.error);
  return parseFreshReview(options.taskId, body.message?.content ?? "");
}
