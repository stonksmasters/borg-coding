import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ProcessRuntime } from "../../process-runtime/src/index.ts";

const dependencyInstallLocks = new Map<string, Promise<void>>();

export function previewDependenciesInstalled(projectPath: string): boolean {
  return ["vite", "@vitejs/plugin-react", "@tailwindcss/vite"]
    .every((name) => existsSync(join(projectPath, "node_modules", name, "package.json")));
}

export async function ensurePreviewDependencies(taskId: string, projectPath: string, runtime: Pick<ProcessRuntime, "run">): Promise<void> {
  const key = resolve(projectPath);
  if (previewDependenciesInstalled(key)) return;
  const existing = dependencyInstallLocks.get(key);
  if (existing) return existing;

  const install = (async () => {
    if (previewDependenciesInstalled(key)) return;
    const result = await runtime.run({
      taskId,
      kind: "command",
      label: "Install website preview dependencies",
      command: "npm",
      args: ["ci", "--no-audit", "--no-fund"],
      cwd: key,
      timeoutMs: 120_000,
    });
    if (result.exitCode !== 0 || !previewDependenciesInstalled(key)) {
      throw new Error(`Website preview dependencies could not be installed. ${result.stderr || result.stdout}`.trim());
    }
  })();

  dependencyInstallLocks.set(key, install);
  try {
    await install;
  } finally {
    if (dependencyInstallLocks.get(key) === install) dependencyInstallLocks.delete(key);
  }
}
