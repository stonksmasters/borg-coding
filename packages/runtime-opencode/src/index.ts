import { spawn } from "node:child_process";
import type { CodingRuntime, RuntimeResult } from "@borg/core";

function collectProcess(command: string, args: string[], cwd?: string, onOutput?: (chunk: string) => void): Promise<RuntimeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: process.platform === "win32", env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (buffer) => {
      const chunk = buffer.toString();
      stdout += chunk;
      onOutput?.(chunk);
    });
    child.stderr.on("data", (buffer) => {
      const chunk = buffer.toString();
      stderr += chunk;
      onOutput?.(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
  });
}

export class OpenCodeRuntime implements CodingRuntime {
  readonly id = "opencode";

  async available(): Promise<boolean> {
    try {
      const result = await collectProcess("opencode", ["--version"]);
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  run(prompt: string, cwd: string, onOutput?: (chunk: string) => void): Promise<RuntimeResult> {
    return collectProcess("opencode", ["run", prompt], cwd, onOutput);
  }
}
