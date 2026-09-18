import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProcessRuntime } from "../../process-runtime/src/index.ts";

export function previewDependenciesInstalled(projectPath: string): boolean {
  return ["vite", "@vitejs/plugin-react", "@tailwindcss/vite"]
    .every((name) => existsSync(join(projectPath, "node_modules", name, "package.json")));
}

export async function ensurePreviewDependencies(taskId: string, projectPath: string, runtime: Pick<ProcessRuntime, "run">): Promise<void> {
  if (previewDependenciesInstalled(projectPath)) return;
  const result = await runtime.run({
    taskId,
    kind: "command",
    label: "Install website preview dependencies",
    command: "npm",
    args: ["ci", "--no-audit", "--no-fund"],
    cwd: projectPath,
    timeoutMs: 120_000,
  });
  if (result.exitCode !== 0 || !previewDependenciesInstalled(projectPath)) {
    throw new Error(`Website preview dependencies could not be installed. ${result.stderr || result.stdout}`.trim());
  }
}
