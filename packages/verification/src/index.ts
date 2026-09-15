import { spawn } from "node:child_process";

export interface VerificationStep {
  name: string;
  command: string;
  args: string[];
}

export interface VerificationResult {
  name: string;
  ok: boolean;
  exitCode: number;
  output: string;
}

async function run(step: VerificationStep, cwd: string, onOutput?: (chunk: string) => void): Promise<VerificationResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(step.command, step.args, { cwd, shell: process.platform === "win32" });
    let output = "";
    const append = (buffer: Buffer) => {
      const chunk = buffer.toString();
      output += chunk;
      onOutput?.(chunk);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", reject);
    child.once("close", (code) => resolve({ name: step.name, ok: code === 0, exitCode: code ?? -1, output }));
  });
}

export async function verifyProject(cwd: string, steps: VerificationStep[] = [
  { name: "typecheck", command: "pnpm", args: ["typecheck"] },
  { name: "test", command: "pnpm", args: ["test"] },
  { name: "build", command: "pnpm", args: ["build"] }
], onOutput?: (chunk: string) => void): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];
  for (const step of steps) {
    const result = await run(step, cwd, onOutput);
    results.push(result);
    if (!result.ok) break;
  }
  return results;
}
