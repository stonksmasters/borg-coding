import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { WorkflowStateSchema } from "../packages/core/src/contracts.ts";
import { GitWorktreeManager } from "../packages/repository/src/git-worktree-manager.ts";
import { projectWorkflowState } from "../packages/web-builder/src/workflow-projection.ts";

function state(version: number) {
  const now = new Date().toISOString();
  return WorkflowStateSchema.parse({
    projectId: "project",
    taskId: "task",
    phase: "frontend",
    status: "running",
    nextAction: "implement",
    planApprovalId: null,
    planApproved: true,
    projectPlan: null,
    sliceIndex: 0,
    sliceTotal: 2,
    sliceTitle: "Hero",
    feedback: [],
    handoff: null,
    pendingCommand: null,
    lastConsumedCommandId: null,
    repairAttempt: 0,
    recoveryCategory: null,
    detail: "test projection",
    version,
    createdAt: now,
    updatedAt: now,
  });
}

test("workflow-state projection migrates out of Git and stays clean in the primary checkout", async () => {
  const root = mkdtempSync(join(tmpdir(), "borg-workflow-projection-"));
  try {
    const repository = join(root, "repository");
    const worktrees = join(root, "worktrees");
    mkdirSync(join(repository, ".localcode", "build"), { recursive: true });
    execFileSync("git", ["init", repository]);
    execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
    writeFileSync(join(repository, "README.md"), "base\n");
    writeFileSync(join(repository, ".localcode", "build", "workflow-state.json"), "{\"legacy\":true}\n");
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync("git", ["-C", repository, "commit", "-m", "base with legacy projection"]);

    const worktree = await new GitWorktreeManager(worktrees).create(repository, "projection-task");
    const projected = projectWorkflowState(worktree.path, state(1), { untrackGeneratedFile: true });
    assert.ok(existsSync(projected));
    assert.match(readFileSync(projected, "utf8"), /"source": "sqlite"/);

    const status = execFileSync("git", ["-C", worktree.path, "status", "--porcelain"], { encoding: "utf8" });
    assert.match(status, /D\s+\.localcode\/build\/workflow-state\.json/);
    execFileSync("git", ["-C", worktree.path, "-c", "user.name=BORG", "-c", "user.email=borg@local", "commit", "-m", "stop tracking generated projection"]);
    const commit = execFileSync("git", ["-C", worktree.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    execFileSync("git", ["-C", repository, "merge", "--ff-only", commit]);

    const baseProjection = projectWorkflowState(repository, state(2));
    assert.ok(existsSync(baseProjection));
    assert.match(readFileSync(baseProjection, "utf8"), /"version": 2/);
    assert.equal(execFileSync("git", ["-C", repository, "status", "--porcelain"], { encoding: "utf8" }).trim(), "");
    assert.equal(execFileSync("git", ["-C", repository, "ls-files", "--", ".localcode/build/workflow-state.json"], { encoding: "utf8" }).trim(), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
