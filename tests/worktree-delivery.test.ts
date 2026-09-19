import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { GitWorktreeManager } from "../packages/repository/src/git-worktree-manager.ts";
import { WorktreeDelivery } from "../packages/repository/src/worktree-delivery.ts";

test("delivery exports a complete patch and can commit without changing the primary checkout", async () => {
  const root = mkdtempSync(join(tmpdir(), "borg-delivery-"));
  const repository = join(root, "repository");
  const worktrees = join(root, "worktrees");
  const deliveries = join(root, "deliveries");
  mkdirSync(repository);
  execFileSync("git", ["init", repository]);
  execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
  writeFileSync(join(repository, "README.md"), "base\n");
  execFileSync("git", ["-C", repository, "add", "."]);
  execFileSync("git", ["-C", repository, "commit", "-m", "base"]);
  const first = await new GitWorktreeManager(worktrees).create(repository, "task-export");
  writeFileSync(join(first.path, "README.md"), "changed\n");
  writeFileSync(join(first.path, "new.txt"), "new\n");
  const delivery = new WorktreeDelivery(worktrees, deliveries);
  const exported = await delivery.deliver("task-export", first.path, "export") as { path: string };
  const patch = readFileSync(exported.path, "utf8");
  assert.match(patch, /changed/);
  assert.match(patch, /new\.txt/);
  assert.equal(readFileSync(join(repository, "README.md"), "utf8"), "base\n");

  const second = await new GitWorktreeManager(worktrees).create(repository, "task-commit");
  writeFileSync(join(second.path, "README.md"), "committed\n");
  const committed = await delivery.deliver("task-commit", second.path, "commit", "Verified change") as { commit: string };
  assert.match(committed.commit, /^[0-9a-f]{40}$/);
  assert.equal(readFileSync(join(repository, "README.md"), "utf8"), "base\n");
  execFileSync("git", ["-C", repository, "worktree", "remove", "--force", first.path]);
  execFileSync("git", ["-C", repository, "worktree", "remove", "--force", second.path]);
  rmSync(root, { recursive: true, force: true });
});

test("saving a reviewed slice advances the project for the next session", async () => {
  const root = mkdtempSync(join(tmpdir(), "borg-slice-delivery-"));
  try {
    const repository = join(root, "repository");
    mkdirSync(repository);
    execFileSync("git", ["init", repository]);
    execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
    writeFileSync(join(repository, "README.md"), "base\n");
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync("git", ["-C", repository, "commit", "-m", "base"]);
    const worktrees = join(root, "worktrees");
    const first = await new GitWorktreeManager(worktrees).create(repository, "slice-one");
    writeFileSync(join(first.path, "README.md"), "slice one\n");
    const delivery = new WorktreeDelivery(worktrees, join(root, "deliveries"));
    await delivery.deliver("slice-one", first.path, "commit", undefined, { repositoryPath: repository, expectedBaseCommit: first.baseCommit });
    assert.equal(readFileSync(join(repository, "README.md"), "utf8").replaceAll("\r\n", "\n"), "slice one\n");
    const second = await new GitWorktreeManager(worktrees).create(repository, "slice-two");
    assert.equal(readFileSync(join(second.path, "README.md"), "utf8").replaceAll("\r\n", "\n"), "slice one\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("interrupted slice promotion is idempotently reconciled from the approved base", async () => {
  const root = mkdtempSync(join(tmpdir(), "borg-delivery-reconcile-"));
  try {
    const repository = join(root, "repository");
    const worktrees = join(root, "worktrees");
    mkdirSync(repository);
    execFileSync("git", ["init", repository]);
    execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
    writeFileSync(join(repository, "README.md"), "base\n");
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync("git", ["-C", repository, "commit", "-m", "base"]);

    const worktree = await new GitWorktreeManager(worktrees).create(repository, "slice-reconcile");
    writeFileSync(join(worktree.path, "README.md"), "recovered slice\n");
    execFileSync("git", ["-C", worktree.path, "add", "-A"]);
    execFileSync("git", ["-C", worktree.path, "-c", "user.name=BORG", "-c", "user.email=borg@local", "commit", "-m", "slice commit"]);
    const worktreeCommit = execFileSync("git", ["-C", worktree.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    const delivery = new WorktreeDelivery(worktrees, join(root, "deliveries"));
    const first = await delivery.reconcilePromotion("slice-reconcile", worktree.path, {
      repositoryPath: repository,
      expectedBaseCommit: worktree.baseCommit,
    });
    assert.equal(first.state, "promoted");
    assert.equal(first.commit, worktreeCommit);
    assert.equal(execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), worktreeCommit);
    assert.equal(readFileSync(join(repository, "README.md"), "utf8").replaceAll("\r\n", "\n"), "recovered slice\n");

    const replay = await delivery.reconcilePromotion("slice-reconcile", worktree.path, {
      repositoryPath: repository,
      expectedBaseCommit: worktree.baseCommit,
    });
    assert.equal(replay.state, "promoted");
    assert.equal(replay.commit, worktreeCommit);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
