import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { BenchmarkTelemetryArtifacts } from "./collector.ts";

export interface BenchmarkArtifactWriteResult {
  runId: string;
  directory: string;
  files: Record<"summary" | "timeline" | "contexts" | "repairs" | "verification" | "invariants", string>;
}

function json(value: unknown) {
  return JSON.stringify(value, null, 2) + "\n";
}

async function applyRepeatability(artifacts: BenchmarkTelemetryArtifacts, resultsRoot: string) {
  const prior: Array<{ completedAt: string; runExceptional: boolean }> = [];
  for (const entry of await readdir(resultsRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.name === artifacts.summary.runId) continue;
    try {
      const value = JSON.parse(await readFile(resolve(resultsRoot, entry.name, "summary.json"), "utf8")) as {
        benchmarkId?: string;
        completedAt?: string;
        quality?: { runExceptional?: boolean; exceptional?: boolean };
      };
      if (value.benchmarkId !== artifacts.summary.benchmarkId || !value.completedAt) continue;
      prior.push({ completedAt: value.completedAt, runExceptional: value.quality?.runExceptional ?? value.quality?.exceptional ?? false });
    } catch { }
  }
  prior.sort((a, b) => a.completedAt.localeCompare(b.completedAt));
  const sequence = [...prior.map((item) => item.runExceptional), artifacts.summary.quality.runExceptional];
  let streak = 0;
  for (let index = sequence.length - 1; index >= 0 && sequence[index]; index -= 1) streak += 1;
  const required = artifacts.summary.quality.repeatability.required;
  artifacts.summary.quality.repeatability = { required, consecutiveExceptionalRuns: streak, satisfied: streak >= required };
  artifacts.summary.quality.exceptional = artifacts.summary.quality.runExceptional && streak >= required;
}

export async function writeBenchmarkArtifacts(
  artifacts: BenchmarkTelemetryArtifacts,
  root = process.cwd(),
): Promise<BenchmarkArtifactWriteResult> {
  const resultsRoot = resolve(root, ".borg", "benchmark-results");
  const directory = resolve(resultsRoot, artifacts.summary.runId);
  await mkdir(directory, { recursive: true });
  await applyRepeatability(artifacts, resultsRoot);

  const files = {
    summary: resolve(directory, "summary.json"),
    timeline: resolve(directory, "timeline.json"),
    contexts: resolve(directory, "contexts.json"),
    repairs: resolve(directory, "repairs.json"),
    verification: resolve(directory, "verification.json"),
    invariants: resolve(directory, "invariants.json"),
  };

  await Promise.all([
    writeFile(files.summary, json(artifacts.summary), "utf8"),
    writeFile(files.timeline, json(artifacts.timeline), "utf8"),
    writeFile(files.contexts, json(artifacts.contexts), "utf8"),
    writeFile(files.repairs, json(artifacts.repairs), "utf8"),
    writeFile(files.verification, json(artifacts.verification), "utf8"),
    writeFile(files.invariants, json(artifacts.invariants), "utf8"),
  ]);

  return {
    runId: artifacts.summary.runId,
    directory,
    files,
  };
}
