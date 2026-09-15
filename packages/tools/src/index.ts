import { spawn } from "node:child_process";
import type { ToolTurn } from "@borg/core";
import { RepositoryTools } from "@borg/repository";
import { verifyProject } from "@borg/verification";

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string`);
  return value;
}

function stringArray(input: Record<string, unknown>, key: string): string[] {
  const value = input[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(`${key} must be an array of strings`);
  return value;
}

function runCommand(command: string, args: string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: process.platform === "win32", env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
  });
}

export class WorkspaceTools {
  private readonly repository: RepositoryTools;

  constructor(readonly root: string) {
    this.repository = new RepositoryTools(root);
  }

  async execute(turn: ToolTurn): Promise<unknown> {
    switch (turn.tool) {
      case "read_file":
        return { content: await this.repository.read(requiredString(turn.input, "path")) };
      case "write_file": {
        const path = requiredString(turn.input, "path");
        const content = requiredString(turn.input, "content");
        await this.repository.write(path, content);
        return { path, bytes: Buffer.byteLength(content, "utf8") };
      }
      case "search_text":
        return { matches: await this.repository.searchText(requiredString(turn.input, "query")) };
      case "git_status":
        return { status: await this.repository.gitStatus() };
      case "git_diff":
        return { diff: await this.repository.gitDiff() };
      case "run_command":
        return runCommand(requiredString(turn.input, "command"), stringArray(turn.input, "args"), this.root);
      case "verify": {
        const results = await verifyProject(this.root);
        return { ok: results.every((result) => result.ok), results };
      }
      default: {
        const exhaustive: never = turn.tool;
        throw new Error(`Unsupported tool: ${exhaustive}`);
      }
    }
  }
}
