import { mkdir, writeFile } from "node:fs/promises";
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

export async function writeBenchmarkArtifacts(
  artifacts: BenchmarkTelemetryArtifacts,
  root = process.cwd(),
): Promise<BenchmarkArtifactWriteResult> {
  const directory = resolve(root, ".borg", "benchmark-results", artifacts.summary.runId);
  await mkdir(directory, { recursive: true });

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
