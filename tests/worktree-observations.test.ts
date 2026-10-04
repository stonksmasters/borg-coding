import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorktreeTools } from "../packages/tools/src/worktree-tools.ts";
import { SqliteTaskRepository } from "../packages/persistence/src/sqlite-task-repository.ts";
import { createTask } from "../packages/core/src/contracts.ts";

test("historical observations survive database reopen, paginate exactly and remain task scoped", async () => {
  const root = mkdtempSync(join(tmpdir(), "borg-observations-"));
  const worktree = join(root, "worktree");
  mkdirSync(worktree);
  let db = new SqliteTaskRepository(join(root, "tasks.sqlite"));
  try {
    db.saveTask(createTask({ id: "one", projectId: "project", request: "build" }));
    const output = { path: "App.tsx", content: 'const value = "🤖";\r\n'.repeat(600) };
    const serialized = JSON.stringify(output);
    const sha256 = createHash("sha256").update(serialized).digest("hex");
    db.saveToolObservation("one", { id: "observation", tool: "worktree_read", output, sha256 });
    db.close();
    db = new SqliteTaskRepository(join(root, "tasks.sqlite"));
    const tools = new WorktreeTools({
      worktreeRoot: root,
      findApproval: (taskId) => ({ taskId, status: "APPROVED", worktreePath: worktree, baseCommit: "base" }),
      findObservation: (taskId, id) => db.findToolObservation(taskId, id),
    });
    let restored = "";
    let offset: number | null = 0;
    do {
      const page = await tools.execute("worktree_observation_read", { observation_id: "observation", offset }, { taskId: "one" }) as { content: string; nextOffset: number | null; historical: boolean };
      assert.equal(page.historical, true);
      assert.ok(JSON.stringify(page).length < 30_000);
      restored += page.content;
      offset = page.nextOffset;
    } while (offset !== null);
    assert.equal(restored, serialized);
    await assert.rejects(() => tools.execute("worktree_observation_read", { observation_id: "observation" }, { taskId: "two" }), /not found/);
    await assert.rejects(() => tools.execute("worktree_observation_read", { observation_id: "observation", offset: -1 }, { taskId: "one" }), /Invalid/);
    await assert.rejects(() => tools.execute("worktree_observation_read", { observation_id: "observation" }), /approved task/);
    db.saveToolObservation("one", { id: "corrupt", tool: "worktree_read", output, sha256: "0".repeat(64) });
    await assert.rejects(() => tools.execute("worktree_observation_read", { observation_id: "corrupt" }, { taskId: "one" }), /integrity/);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
