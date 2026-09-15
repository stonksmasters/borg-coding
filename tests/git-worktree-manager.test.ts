import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GitWorktreeManager } from "../packages/repository/src/git-worktree-manager.ts";

test("creates a detached worktree for a validated task", async () => {
  const root = mkdtempSync(join(tmpdir(), "borg-worktree-"));
  const repository = join(root, "repo");
  const worktrees = join(root, "worktrees");
  try {
    mkdirSync(repository);
    execFileSync("git", ["init", repository], { stdio: "ignore" });
    execFileSync("git", ["-C", repository, "config", "user.email", "borg-test@example.invalid"]);
    execFileSync("git", ["-C", repository, "config", "user.name", "BORG Test"]);
    writeFileSync(join(repository, "README.md"), "# Isolated\n");
    execFileSync("git", ["-C", repository, "add", "README.md"]);
    execFileSync("git", ["-C", repository, "commit", "-m", "initial"], { stdio: "ignore" });

    const result = await new GitWorktreeManager(worktrees).create(repository, "task-123");
    assert.equal(result.path, join(worktrees, "task-123"));
    assert.ok(existsSync(join(result.path, "README.md")));
    assert.match(result.baseCommit, /^[0-9a-f]{40}$/);
    assert.equal(execFileSync("git", ["-C", result.path, "branch", "--show-current"], { encoding: "utf8" }).trim(), "");

    execFileSync("git", ["-C", repository, "worktree", "remove", "--force", result.path], { stdio: "ignore" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects unsafe task identifiers before creating a worktree", async () => {
  const manager = new GitWorktreeManager(join(tmpdir(), "borg-worktrees"));
  await assert.rejects(() => manager.create(process.cwd(), "../escape"), /not safe/);
});
