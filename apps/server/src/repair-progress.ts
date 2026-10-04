import { createHash } from "node:crypto";

export interface RepairProgressState { fingerprint: string; repetitions: number; }

/** Ignore clocks and process IDs; compare source plus actual failed command/browser evidence. */
export function repairProgress(previous: RepairProgressState | null, source: string, verification: {
  results?: Array<{ command?: string; args?: string[]; exitCode?: number; stdout?: string; stderr?: string }>;
  browserEvidence?: { issues?: string[] } | null;
  passed?: boolean;
}): RepairProgressState & { stalled: boolean } {
  const fingerprint = createHash("sha256").update(JSON.stringify({ source,
    commands: (verification.results ?? []).map(({ command, args, exitCode, stdout, stderr }) => ({ command, args, exitCode, stdout, stderr })),
    browser: verification.browserEvidence?.issues ?? [],
  })).digest("hex");
  const repetitions = previous?.fingerprint === fingerprint ? previous.repetitions + 1 : 1;
  return { fingerprint, repetitions, stalled: !verification.passed && repetitions >= 2 };
}
