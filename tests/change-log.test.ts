import assert from "node:assert/strict";
import test from "node:test";
import { buildChangeLog } from "../apps/server/src/change-log.ts";

test("buildChangeLog reports added, modified, deleted, and renamed files with diff stats", () => {
  const status = [
    " M src/runtime.ts",
    "?? src/activity.ts",
    " D src/old.ts",
    "R  src/before.ts -> src/after.ts",
  ].join("\n");
  const diff = [
    "diff --git a/src/runtime.ts b/src/runtime.ts",
    "--- a/src/runtime.ts",
    "+++ b/src/runtime.ts",
    "@@ -1 +1,2 @@",
    "-old",
    "+new",
    "+next",
    "diff --git a/src/activity.ts b/src/activity.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/activity.ts",
    "@@ -0,0 +1 @@",
    "+hello",
    "diff --git a/src/old.ts b/src/old.ts",
    "deleted file mode 100644",
    "--- a/src/old.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-gone",
    "diff --git a/src/before.ts b/src/after.ts",
    "similarity index 90%",
    "rename from src/before.ts",
    "rename to src/after.ts",
  ].join("\n");

  const result = buildChangeLog(status, diff);
  assert.equal(result.clean, false);
  assert.equal(result.files.length, 4);
  assert.equal(result.additions, 3);
  assert.equal(result.deletions, 2);
  assert.deepEqual(result.files.map((file) => [file.path, file.status]), [
    ["src/activity.ts", "added"],
    ["src/after.ts", "renamed"],
    ["src/old.ts", "deleted"],
    ["src/runtime.ts", "modified"],
  ]);
  assert.equal(result.files.find((file) => file.path === "src/after.ts")?.previousPath, "src/before.ts");
});

test("buildChangeLog returns a clean change set for an unchanged worktree", () => {
  assert.deepEqual(buildChangeLog("", ""), { files: [], additions: 0, deletions: 0, diff: "", clean: true });
});
