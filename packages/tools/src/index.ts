import { spawn } from "node:child_process";
import type { ToolName, ToolTurn } from "@borg/core";
import { RepositoryTools } from "@borg/repository";
import { verifyProject } from "@borg/verification";

export interface WorkspaceToolOptions {
  taskId: string;
  onOutput?: (tool: ToolName, stream: "stdout" | "stderr" | "info", text: string) => void;
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string`);
  return value;
}

function stringValue(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

function stringArray(input: Record<string, unknown>, key: string): string[] {
  const value = input[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(`${key} must be an array of strings`);
  return value;
}

function runCommand(command: string, args: string[], cwd: string, onOutput?: (stream: "stdout" | "stderr", text: string) => void): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: process.platform === "win32", env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      onOutput?.("stdout", text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      onOutput?.("stderr", text);
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
  });
}

export class WorkspaceTools {
  private readonly repository: RepositoryTools;

  constructor(readonly root: string, private readonly options: WorkspaceToolOptions) {
    this.repository = new RepositoryTools(root);
  }

  async execute(turn: ToolTurn): Promise<unknown> {
    switch (turn.tool) {
      case "read_file":
        return { content: await this.repository.read(requiredString(turn.input, "path")) };
      case "write_file": {
        const path = requiredString(turn.input, "path");
        const content = stringValue(turn.input, "content");
        const checkpoint = await this.repository.createCheckpoint(this.options.taskId, path);
        await this.repository.write(path, content);
        return { path, bytes: Buffer.byteLength(content, "utf8"), checkpointId: checkpoint.id };
      }
      case "search_text":
        return { matches: await this.repository.searchText(requiredString(turn.input, "query")) };
      case "git_status":
        return { status: await this.repository.gitStatus() };
      case "git_diff":
        return { diff: await this.repository.gitDiff() };
      case "run_command": {
        const tool = turn.tool;
        return runCommand(requiredString(turn.input, "command"), stringArray(turn.input, "args"), this.root, (stream, text) => this.options.onOutput?.(tool, stream, text));
      }
      case "verify": {
        const results = await verifyProject(this.root, undefined, (text) => this.options.onOutput?.(turn.tool, "info", text));
        return { ok: results.every((result) => result.ok), results };
      }
      case "undo_last_change": {
        const checkpoint = await this.repository.restoreLastCheckpoint(this.options.taskId);
        if (!checkpoint) return { restored: false, reason: "No checkpoint exists for this task." };
        return { restored: true, path: checkpoint.path, checkpointId: checkpoint.id };
      }
      default: {
        const exhaustive: never = turn.tool;
        throw new Error(`Unsupported tool: ${exhaustive}`);
      }
    }
  }

  async diffState(): Promise<{ status: string; diff: string }> {
    const [status, diff] = await Promise.all([this.repository.gitStatus(), this.repository.gitDiff()]);
    return { status, diff };
  }
}
