import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GitWorktreeManager } from "../packages/repository/src/git-worktree-manager.ts";
import { WorktreeTools, type RecordedApproval } from "../packages/tools/src/worktree-tools.ts";

test("worktree mutation requires approval and remains inside the recorded task worktree", async () => {
  const root = mkdtempSync(join(tmpdir(), "borg-mutation-"));
  const repository = join(root, "repo");
  const worktreeRoot = join(root, "worktrees");
  mkdirSync(repository);
  try {
    execFileSync("git", ["init", repository], { stdio: "ignore" });
    execFileSync("git", ["-C", repository, "config", "user.email", "borg-test@example.invalid"]);
    execFileSync("git", ["-C", repository, "config", "user.name", "BORG Test"]);
    writeFileSync(join(repository, "README.md"), "# Original\n");
    writeFileSync(join(repository, "package.json"), JSON.stringify({ scripts: { check: "node -e \"process.exit(0)\"" } }));
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync("git", ["-C", repository, "commit", "-m", "initial"], { stdio: "ignore" });

    const worktree = await new GitWorktreeManager(worktreeRoot).create(repository, "task-approved");
    let approval: RecordedApproval = { taskId: "task-approved", status: "REQUESTED", worktreePath: null, baseCommit: null };
    const tools = new WorktreeTools({ worktreeRoot, findApproval: () => approval });
    const context = { taskId: "task-approved" };

    await assert.rejects(() => tools.execute("worktree_patch", { path: "README.md", old_text: "Original", new_text: "Changed" }, context), /approved worktree/);
    approval = { taskId: context.taskId, status: "APPROVED", worktreePath: worktree.path, baseCommit: worktree.baseCommit };

    const patched = await tools.execute("worktree_patch", { path: "README.md", old_text: "Original", new_text: "Changed" }, context) as { replacements: number };
    assert.equal(patched.replacements, 1);
    const read = await tools.execute("worktree_read", { path: "README.md" }, context) as { content: string };
    assert.match(read.content, /Changed/);
    writeFileSync(join(worktree.path, "windows.txt"), "first\r\nsecond\r\n");
    await tools.execute("worktree_patch", {
      path: "windows.txt", old_text: "first\nsecond", new_text: "updated\nsecond",
    }, context);
    const windowsRead = await tools.execute("worktree_read", { path: "windows.txt" }, context) as { content: string };
    assert.equal(windowsRead.content, "updated\r\nsecond\r\n");
    assert.equal(execFileSync("git", ["-C", repository, "status", "--short"], { encoding: "utf8" }), "");

    const status = await tools.execute("git_status", {}, context) as { stdout: string };
    const diff = await tools.execute("git_diff", {}, context) as { stdout: string };
    assert.match(status.stdout, /README\.md/);
    assert.match(diff.stdout, /Changed/);

    const command = await tools.execute("worktree_command", { command: "node", args: ["-e", "process.stdout.write('bounded')"], timeout_seconds: 5 }, context) as { exitCode: number; stdout: string };
    assert.equal(command.exitCode, 0);
    assert.equal(command.stdout, "bounded");
    await assert.rejects(() => tools.execute("worktree_command", { command: "npm", args: ["run", "dev"] }, context), /browser_server_start/);

    const verification = await tools.execute("verification_run", { profile: "quick" }, context) as { passed: boolean };
    assert.equal(verification.passed, true);
    writeFileSync(join(worktree.path, "package.json"), JSON.stringify({ scripts: { build: "node -e \"process.exit(0)\"" } }));
    const buildOnlyProfile = await tools.execute("verification_run", { profile: "quick" }, context) as { passed: boolean; results: Array<{ label: string }> };
    assert.equal(buildOnlyProfile.passed, true);
    assert.equal(buildOnlyProfile.results[0]?.label, "npm run build");

    await assert.rejects(() => tools.execute("worktree_read", { path: "../README.md" }, context), /Unsafe|relative/);
    execFileSync("git", ["-C", repository, "worktree", "remove", "--force", worktree.path], { stdio: "ignore" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
