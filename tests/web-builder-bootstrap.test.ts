import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWebsiteProject, websiteInfo, websiteSlug } from "../packages/web-builder/src/project-bootstrap.ts";

test("website bootstrap creates a committed React project and can be restored from its path", async () => {
  const root = mkdtempSync(join(tmpdir(), "borg-websites-"));
  try {
    const project = await createWebsiteProject("Miller's Glass", root, async () => {});
    assert.equal(project.slug, "miller-s-glass");
    assert.ok(existsSync(join(project.path, ".git")));
    assert.ok(existsSync(join(project.path, "src", "main.tsx")));
    assert.ok(existsSync(join(project.path, "src", "App.tsx")));
    assert.ok(existsSync(join(project.path, "src", "design", "tokens.css")));
    assert.equal(websiteInfo(project.path)?.name, "Miller's Glass");
    const manifest = JSON.parse(readFileSync(join(project.path, ".borg-website.json"), "utf8")) as { framework: string; starterVersion?: number; designPipeline?: string };
    assert.equal(manifest.framework, "vite-react");
    assert.equal(manifest.starterVersion, 2);
    assert.equal(manifest.designPipeline, "premium-v1");
    const packageJson = JSON.parse(readFileSync(join(project.path, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    assert.ok(packageJson.dependencies?.["lucide-react"]);
    assert.ok(packageJson.dependencies?.motion);
    assert.ok(packageJson.devDependencies?.tailwindcss);
    assert.ok(packageJson.devDependencies?.["@tailwindcss/vite"]);
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: project.path, encoding: "utf8" }).trim(), "");
    const worktreePath = join(root, "approved-worktree");
    execFileSync("git", ["worktree", "add", "-b", "preview-test", worktreePath], { cwd: project.path });
    assert.equal(websiteInfo(worktreePath)?.name, "Miller's Glass");
    await assert.rejects(() => createWebsiteProject("Miller's Glass", root, async () => {}), /already exists/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("website names cannot escape their project root", () => {
  assert.throws(() => websiteSlug("../"), /Choose a website name/);
  assert.equal(websiteSlug("Summer & Stone"), "summer-stone");
});

test("failed installation removes the newly created project so creation can be retried", async () => {
  const root = mkdtempSync(join(tmpdir(), "borg-website-retry-"));
  try {
    await assert.rejects(() => createWebsiteProject("Retry Site", root, async () => { throw new Error("offline"); }), /offline/);
    assert.equal(existsSync(join(root, "retry-site")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
