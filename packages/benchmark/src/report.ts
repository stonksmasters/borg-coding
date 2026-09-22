import type { BenchmarkTelemetryArtifacts } from "./collector.ts";

function percent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function duration(value: number | null) {
  if (value === null) return "unknown";
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function statusMark(status: string) {
  if (status === "PASS") return "PASS";
  if (status === "FAIL") return "FAIL";
  if (status === "BLOCKED") return "BLOCKED";
  return "INVALID";
}

export function formatBenchmarkReport(artifacts: BenchmarkTelemetryArtifacts) {
  const { summary } = artifacts;
  const lines: string[] = [];
  lines.push(`BORG FRONTEND AUTONOMY — ${summary.benchmarkName.toUpperCase()}`);
  lines.push("=".repeat(Math.min(72, Math.max(36, lines[0].length))));
  lines.push("");
  lines.push(`Result: ${statusMark(summary.status)}`);
  lines.push(`Run: ${summary.runId}`);
  lines.push(`Duration: ${duration(summary.durationMs)}`);
  lines.push(`Tasks observed: ${summary.taskCount}`);
  lines.push(`Slices observed: ${summary.observedSliceCount}`);
  lines.push(`Plan approvals: ${summary.approvals.projectPlan} · revisions: ${summary.approvals.projectPlanRevision}`);
  lines.push(`Project replans during slices: ${summary.planning.outerReplanEventCount}`);
  lines.push("");

  if (summary.observedSlices.length) {
    lines.push("Slices");
    for (const slice of summary.observedSlices) {
      const verification = artifacts.verification.find((item) => item.taskId === slice.taskId);
      const repair = artifacts.repairs.find((item) => item.taskId === slice.taskId);
      const verificationLabel = verification?.persistedStatus ?? "unknown";
      const repairLabel = repair?.repairAttempt ? ` · repair ${repair.repairAttempt}` : "";
      lines.push(`  ${slice.index + 1}. ${slice.title ?? "Untitled"} · ${verificationLabel}${repairLabel}`);
    }
    lines.push("");
  }

  lines.push("Context");
  lines.push(`  Packs: ${summary.context.packCount}`);
  lines.push(`  Peak: ${summary.context.maximumCharacters.toLocaleString()} / ${summary.context.configuredMaximumCharacters.toLocaleString()} chars`);
  lines.push(`  Average: ${summary.context.averageCharacters.toLocaleString()} chars`);
  lines.push(`  Peak utilization: ${percent(summary.context.peakUtilization)}`);
  const contextsBySlice = new Map<string, number>();
  for (const pack of artifacts.contexts.packs) {
    const label = pack.sliceTitle ?? pack.sliceId ?? "unscoped";
    contextsBySlice.set(label, Math.max(contextsBySlice.get(label) ?? 0, pack.characters));
  }
  for (const [label, characters] of contextsBySlice) {
    lines.push(`  ${label}: ${characters.toLocaleString()} chars`);
  }
  lines.push("");

  lines.push("Quality");
  lines.push(`  Verification passed: ${summary.verification.passedTaskCount}/${summary.verification.taskCount}`);
  lines.push(`  Pre-delivery checkpoints: ${summary.verification.preDeliveryCheckpointCount}`);
  lines.push(`  Tasks requiring repair: ${summary.repair.tasksWithRepair}`);
  lines.push(`  Recovery/repair events: ${summary.repair.recoveryEventCount}`);
  lines.push(`  Invariant violations: ${summary.invariantViolationCount}`);

  if (summary.failures.count) {
    lines.push("");
    lines.push("Failures");
    for (const failure of artifacts.invariants.violations) {
      lines.push(`  - [${failure.category}] ${failure.code}: ${failure.message}`);
    }
    const invariantCodes = new Set(artifacts.invariants.violations.map((item) => item.code));
    for (const code of summary.failures.codes) {
      if (!invariantCodes.has(code)) lines.push(`  - ${code}`);
    }
  }

  return lines.join("\n");
}
