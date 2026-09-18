import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWebsiteProject, prepareWebsiteWorkspace, websiteInfo, websiteSlug, websiteWorkspaceDirectories } from "../packages/web-builder/src/project-bootstrap.ts";
import { websiteGenerationContext } from "../packages/web-builder/src/generation-context.ts";

test("website bootstrap creates a committed React project and can be restored from its path", async () => {
  const root = mkdtempSync(join(tmpdir(), "borg-websites-"));
  try {
    const project = await createWebsiteProject("Miller's Glass", root, async () => {}, { template: "portfolio", originalBrief: "Build a premium glass studio portfolio." });
    assert.equal(project.slug, "miller-s-glass");
    assert.ok(existsSync(join(project.path, ".git")));
    assert.ok(existsSync(join(project.path, "src", "main.tsx")));
    assert.ok(existsSync(join(project.path, "src", "App.tsx")));
    assert.ok(existsSync(join(project.path, "src", "design", "tokens.css")));
    assert.ok(existsSync(join(project.path, "server", "db.ts")));
    assert.ok(existsSync(join(project.path, "server", "local-api.ts")));
    for (const directory of websiteWorkspaceDirectories) assert.ok(existsSync(join(project.path, directory)), `missing workspace directory: ${directory}`);
    rmSync(join(project.path, "src", "features"), { recursive: true, force: true });
    assert.equal(existsSync(join(project.path, "src", "features")), false);
    const repaired = prepareWebsiteWorkspace(project.path);
    assert.ok(repaired.includes("src/features"));
    assert.ok(existsSync(join(project.path, "src", "features")));
    assert.equal(websiteInfo(project.path)?.name, "Miller's Glass");
    const manifest = JSON.parse(readFileSync(join(project.path, ".borg-website.json"), "utf8")) as {
      framework: string;
      starterVersion?: number;
      designPipeline?: string;
      template?: string;
      status?: string;
      originalBrief?: string | null;
      createdAt?: string;
      lastOpenedAt?: string;
    };
    assert.equal(manifest.framework, "vite-react");
    assert.equal(manifest.starterVersion, 3);
    assert.equal(manifest.designPipeline, "premium-v1");
    assert.equal(manifest.template, "portfolio");
    assert.equal(manifest.status, "new");
    assert.equal(manifest.originalBrief, "Build a premium glass studio portfolio.");
    assert.ok(manifest.createdAt);
    assert.equal(manifest.lastOpenedAt, manifest.createdAt);
    const info = websiteInfo(project.path);
    assert.equal(info?.template, "portfolio");
    assert.equal(info?.originalBrief, "Build a premium glass studio portfolio.");
    const packageJson = JSON.parse(readFileSync(join(project.path, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    assert.ok(packageJson.dependencies?.["lucide-react"]);
    assert.ok(packageJson.dependencies?.motion);
    assert.ok(packageJson.devDependencies?.tailwindcss);
    assert.ok(packageJson.devDependencies?.["@tailwindcss/vite"]);
    assert.ok(packageJson.devDependencies?.["@types/node"]);
    assert.match(readFileSync(join(project.path, "vite.config.ts"), "utf8"), /borgLocalApi/);
    assert.match(readFileSync(join(project.path, "server", "db.ts"), "utf8"), /CREATE TABLE IF NOT EXISTS submissions/);
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


test("website generation contract separates first generation from follow-up edits", () => {
  const project = { name: "Acme", template: "waitlist" as const, originalBrief: "Launch an AI note-taking waitlist." };
  const initial = websiteGenerationContext(project, "initial_generation");
  const followUp = websiteGenerationContext(project, "iterative_edit");
  assert.match(initial, /first AI generation/i);
  assert.match(initial, /complete, cohesive first version/i);
  assert.match(initial, /SQLite/i);
  assert.match(followUp, /follow-up edit/i);
  assert.match(followUp, /smallest coherent change/i);
  assert.match(followUp, /Original website brief: Launch an AI note-taking waitlist/);
});
