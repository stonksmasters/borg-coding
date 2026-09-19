import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectProjectTree, resolveProjectPath } from "../packages/repository/src/project-inspection.ts";

test("project inspection is bounded and hides sensitive or generated paths", () => {
  const root = mkdtempSync(join(tmpdir(), "borg-project-tree-"));
  try {
    mkdirSync(join(root, "src", "components"), { recursive: true });
    mkdirSync(join(root, "node_modules", "hidden"), { recursive: true });
    writeFileSync(join(root, "src", "app.ts"), "export const app = true;\n");
    writeFileSync(join(root, "src", "components", "Card.tsx"), "export const Card = () => null;\n");
    writeFileSync(join(root, ".env"), "SECRET=hidden\n");
    writeFileSync(join(root, ".npmrc"), "token=hidden\n");
    writeFileSync(join(root, "node_modules", "hidden", "index.js"), "hidden\n");

    const tree = inspectProjectTree(root);
    assert.equal(tree.truncated, false);
    assert.ok(tree.entries.some((entry) => entry.path === "src/app.ts"));
    assert.ok(tree.entries.some((entry) => entry.path === "src/components/Card.tsx"));
    assert.equal(tree.entries.some((entry) => entry.path.includes(".env")), false);
    assert.equal(tree.entries.some((entry) => entry.path.includes(".npmrc")), false);
    assert.equal(tree.entries.some((entry) => entry.path.startsWith("node_modules")), false);

    const bounded = inspectProjectTree(root, { maxEntries: 1 });
    assert.equal(bounded.entries.length, 1);
    assert.equal(bounded.truncated, true);

    assert.equal(resolveProjectPath(root, "src/app.ts"), join(root, "src", "app.ts"));
    assert.throws(() => resolveProjectPath(root, "../outside.ts"), /inside the selected workspace/);
    assert.throws(() => resolveProjectPath(root, ".env"), /Sensitive project files/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
