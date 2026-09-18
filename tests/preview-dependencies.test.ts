import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensurePreviewDependencies, previewDependenciesInstalled } from "../packages/web-builder/src/preview-dependencies.ts";
import type { ProcessRuntime } from "../packages/process-runtime/src/index.ts";

function markInstalled(root: string) {
  for (const name of ["vite", "@vitejs/plugin-react", "@tailwindcss/vite"]) {
    const folder = join(root, "node_modules", name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "package.json"), "{}");
  }
}

test("preview installs missing worktree dependencies and checks the result", async () => {
  const root = mkdtempSync(join(tmpdir(), "borg-preview-deps-"));
  try {
    let calls = 0;
    const runtime = { run: async (input: { args?: string[]; cwd: string }) => {
      calls += 1;
      assert.deepEqual(input.args, ["ci", "--no-audit", "--no-fund"]);
      assert.equal(input.cwd, root);
      markInstalled(root);
      return { exitCode: 0, stderr: "", stdout: "" };
    } } as unknown as Pick<ProcessRuntime, "run">;
    assert.equal(previewDependenciesInstalled(root), false);
    await ensurePreviewDependencies("task", root, runtime);
    assert.equal(previewDependenciesInstalled(root), true);
    await ensurePreviewDependencies("task", root, runtime);
    assert.equal(calls, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("preview reports a failed dependency install", async () => {
  const root = mkdtempSync(join(tmpdir(), "borg-preview-deps-fail-"));
  try {
    const runtime = { run: async () => ({ exitCode: 1, stderr: "install failed", stdout: "" }) } as unknown as Pick<ProcessRuntime, "run">;
    await assert.rejects(() => ensurePreviewDependencies("task", root, runtime), /install failed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
