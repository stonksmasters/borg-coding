import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DisciplineRouter, TeamPolicyService, roleAllowsTool, roleCapabilities } from "../packages/orchestration/src/index.ts";

test("discipline routing is deterministic across request and changed-file signals", () => {
  const route = new DisciplineRouter().route(
    "Add authorization to the API and cover it with accessibility regression tests",
    ["app/account/page.tsx", "tests/account.test.ts"],
  );

  assert.equal(route.primary, "security");
  assert.deepEqual(route.disciplines, ["security", "backend", "qa", "frontend"]);
  assert.ok(route.reasons.includes("security-sensitive request"));
  assert.ok(route.reasons.includes("frontend files changed"));
});

test("role capabilities isolate mutation and independent review", () => {
  assert.equal(roleAllowsTool("architect", "repository_search"), true);
  assert.equal(roleAllowsTool("architect", "worktree_patch"), false);
  assert.equal(roleAllowsTool("implementer", "worktree_patch"), true);
  assert.equal(roleAllowsTool("verifier", "verification_run"), true);
  assert.equal(roleAllowsTool("verifier", "worktree_command"), false);
  assert.deepEqual(roleCapabilities("reviewer"), []);
  assert.equal(roleAllowsTool("reviewer", "git_diff"), false);
});

test("team policy loads bounded per-role model overrides", () => {
  const root = mkdtempSync(join(tmpdir(), "borg-team-policy-"));
  try {
    mkdirSync(join(root, ".localcode"));
    writeFileSync(join(root, ".localcode", "team.json"), JSON.stringify({
      version: 1,
      defaultDiscipline: "backend",
      roles: {
        architect: { model: "architect-local" },
        implementer: { model: null },
        verifier: { model: "verifier-local" },
        reviewer: { model: "reviewer-local" },
      },
    }));

    const service = new TeamPolicyService();
    const policy = service.load(root);
    assert.equal(policy.defaultDiscipline, "backend");
    assert.equal(service.modelFor(policy, "architect", "fallback"), "architect-local");
    assert.equal(service.modelFor(policy, "implementer", "fallback"), "fallback");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
