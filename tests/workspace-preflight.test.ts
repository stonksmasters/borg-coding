import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contractForWorkspace } from "../packages/web-builder/src/workspace-contract.ts";
import { runWorkspacePreflight } from "../packages/web-builder/src/workspace-preflight.ts";

function initRepository(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

function commit(root: string) {
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.name=BORG Test", "-c", "user.email=borg@example.test", "commit", "-q", "-m", "fixture"], { cwd: root });
}

test("workspace preflight detects Vite React and recreates only its contract directories", () => {
  const root = initRepository("borg-preflight-vite-");
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "main.tsx"), "export {}\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({
      scripts: { dev: "vite", build: "vite build" },
      dependencies: { react: "19.0.0" },
      devDependencies: { vite: "8.0.0" },
    }));
    commit(root);

    const report = runWorkspacePreflight(root, { reason: "test", repair: true });
    assert.equal(report.passed, true);
    assert.equal(report.contract.kind, "vite-react");
    assert.ok(report.repairedDirectories.includes("src/features"));
    assert.ok(existsSync(join(root, "src", "features")));
    assert.ok(existsSync(join(root, "server", "routes")));
    assert.equal(report.dependencyState, "install_missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace contracts distinguish Next routers without spraying Vite/server folders", () => {
  for (const fixture of [
    { name: "app", route: "app", expected: "next-app-router" },
    { name: "pages", route: "pages", expected: "next-pages-router" },
  ] as const) {
    const root = initRepository(`borg-preflight-next-${fixture.name}-`);
    try {
      mkdirSync(join(root, fixture.route), { recursive: true });
      writeFileSync(join(root, fixture.route, "index.tsx"), "export default function Page(){return null}\n");
      writeFileSync(join(root, "package.json"), JSON.stringify({
        scripts: { dev: "next dev", build: "next build" },
        dependencies: { next: "16.0.0", react: "19.0.0" },
      }));
      commit(root);
      const report = runWorkspacePreflight(root, { repair: true });
      assert.equal(report.passed, true);
      assert.equal(report.contract.kind, fixture.expected);
      assert.equal(existsSync(join(root, "server")), false);
      assert.equal(existsSync(join(root, fixture.route === "app" ? "pages" : "app")), false);
      assert.ok(existsSync(join(root, "components", "ui")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("generic React and custom repositories receive conservative contracts", () => {
  const reactRoot = initRepository("borg-preflight-react-");
  const customRoot = initRepository("borg-preflight-custom-");
  try {
    mkdirSync(join(reactRoot, "src"), { recursive: true });
    writeFileSync(join(reactRoot, "src", "index.tsx"), "export {}\n");
    writeFileSync(join(reactRoot, "package.json"), JSON.stringify({ dependencies: { react: "19.0.0" } }));
    commit(reactRoot);
    const reactReport = runWorkspacePreflight(reactRoot, { repair: true });
    assert.equal(reactReport.contract.kind, "react-custom");
    assert.ok(existsSync(join(reactRoot, "src", "features")));
    assert.equal(existsSync(join(reactRoot, "server")), false);
    assert.equal(existsSync(join(reactRoot, "src", "pages")), false);

    writeFileSync(join(customRoot, "README.md"), "# custom\n");
    commit(customRoot);
    const customReport = runWorkspacePreflight(customRoot, { repair: true });
    assert.equal(customReport.contract.kind, "existing-custom");
    assert.ok(existsSync(join(customRoot, ".localcode", "build")));
    assert.equal(existsSync(join(customRoot, "src")), false);
    assert.deepEqual(contractForWorkspace(customRoot).sourceRoots, []);
  } finally {
    rmSync(reactRoot, { recursive: true, force: true });
    rmSync(customRoot, { recursive: true, force: true });
  }
});

test("preflight blocks malformed project configuration and non-git workspaces", () => {
  const invalidPackage = initRepository("borg-preflight-invalid-package-");
  const noGit = mkdtempSync(join(tmpdir(), "borg-preflight-no-git-"));
  try {
    writeFileSync(join(invalidPackage, "package.json"), "{not-json");
    writeFileSync(join(invalidPackage, "README.md"), "fixture\n");
    commit(invalidPackage);
    const packageReport = runWorkspacePreflight(invalidPackage, { repair: true });
    assert.equal(packageReport.passed, false);
    assert.ok(packageReport.issues.some((issue) => issue.code === "package_json_invalid" && issue.severity === "fatal"));

    writeFileSync(join(noGit, "README.md"), "not git\n");
    const gitReport = runWorkspacePreflight(noGit, { repair: true });
    assert.equal(gitReport.passed, false);
    assert.ok(gitReport.issues.some((issue) => issue.code === "git_worktree_invalid"));
  } finally {
    rmSync(invalidPackage, { recursive: true, force: true });
    rmSync(noGit, { recursive: true, force: true });
  }
});

