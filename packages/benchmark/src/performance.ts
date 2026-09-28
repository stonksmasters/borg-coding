import type { FrontendBenchmarkRunnerOutcome } from "./runner.ts";

export type BenchmarkStage = "planning" | "generating" | "verifying" | "repairing" | "awaiting_approval" | "other";

function stage(state: string | null, name: string | null): BenchmarkStage {
  if (state === "AWAITING_APPROVAL") return "awaiting_approval";
  if (/repair/i.test(name ?? "")) return "repairing";
  if (state === "IMPLEMENTING") return "generating";
  if (state === "VERIFYING" || state === "REVIEWING") return "verifying";
  if (["CREATED", "CLASSIFYING", "DISCOVERING", "PLANNING"].includes(state ?? "")) return "planning";
  return "other";
}

/** Observation durations are estimates; missing telemetry is never reported as zero usage. */
export function benchmarkPerformance(outcome: FrontendBenchmarkRunnerOutcome) {
  const start = Date.parse(outcome.result.startedAt);
  const end = outcome.result.completedAt ? Date.parse(outcome.result.completedAt) : NaN;
  const observations = [...outcome.observations].filter((item) => Number.isFinite(Date.parse(item.at)))
    .sort((a, b) => a.at.localeCompare(b.at));
  const stageMs: Record<BenchmarkStage, number> = { planning: 0, generating: 0, verifying: 0, repairing: 0, awaiting_approval: 0, other: 0 };
  let observedMs = 0;
  for (let index = 0; index < observations.length; index++) {
    const item = observations[index];
    const until = Math.min(end, index + 1 < observations.length ? Date.parse(observations[index + 1].at) : end);
    const elapsed = Math.max(0, until - Math.max(start, Date.parse(item.at)));
    if (!Number.isFinite(elapsed)) continue;
    stageMs[stage(item.taskState, item.stage)] += elapsed;
    observedMs += elapsed;
  }
  const events = [...new Map(outcome.snapshots.flatMap((snapshot) => snapshot.events)
    .map((event) => [event.id, event])).values()];
  // A running server is not evidence that a website rendered.
  const preview = events.filter((event) => event.sourceType === "WEBSITE_PREVIEW_RENDERED")
    .map((event) => Date.parse(event.occurredAt)).filter((at) => Number.isFinite(at) && at >= start).sort((a, b) => a - b)[0];
  const modelInputs = new Set(outcome.snapshots.flatMap((snapshot) => snapshot.modelContexts ?? []).map((item) => item.id));
  const modelEvents = events.filter((event) => event.sourceType === "MODEL_CONTEXT_RECORDED");
  const toolEvents = events.filter((event) => event.sourceType === "TOOL_STARTED" || event.sourceType === "TOOL_CALL_STARTED");
  const last = observations.at(-1);
  return {
    timingBasis: "sampled_observations" as const,
    firstRenderedPreviewMs: preview === undefined ? null : preview - start,
    stageMs,
    unobservedMs: Number.isFinite(end) ? Math.max(0, end - start - observedMs) : null,
    recordedModelRequests: modelInputs.size || modelEvents.length || null,
    recordedToolCalls: toolEvents.length || null,
    terminalStage: last?.stage ?? null,
    terminalTaskState: last?.taskState ?? null,
    evidenceRevisions: events.filter((event) => event.sourceType === "WEBSITE_PREVIEW_RENDERED")
      .map((event) => ({ taskId: event.data?.taskId ?? null, sourceRevision: event.data?.sourceRevision ?? null, capturedAt: event.occurredAt })),
  };
}
