import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DisciplineRouter,
  TeamPolicyService,
  evaluateSpecialistEvidence,
  minimumRiskFor,
  roleAllowsTool,
  roleCapabilities,
  selectSpecialistPacks,
  specialistAllowsTool,
  specialistPackRefs,
  specialistSystemInstructions,
  verificationProfileFor,
} from "../packages/orchestration/src/index.ts";

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

test("specialist packs are versioned and materially change policy", () => {
  const frontend = selectSpecialistPacks(["frontend"]);
  const backend = selectSpecialistPacks(["backend"]);
  const securityAndQa = selectSpecialistPacks(["security", "qa"]);

  assert.deepEqual(specialistPackRefs(frontend), [{ id: "frontend.web", version: 1, discipline: "frontend" }]);
  assert.equal(specialistAllowsTool(["frontend"], "browser_capture"), true);
  assert.equal(specialistAllowsTool(["backend"], "browser_capture"), false);
  assert.equal(verificationProfileFor(frontend), "quick");
  assert.equal(verificationProfileFor(securityAndQa), "full");
  assert.equal(minimumRiskFor(securityAndQa), "R3");
  assert.match(specialistSystemInstructions(frontend, "implementer"), /responsive screenshots/i);
  assert.match(specialistSystemInstructions(backend, "reviewer"), /compatibility/i);
});

test("frontend evidence gate rejects missing or failed browser evidence", () => {
  const frontend = selectSpecialistPacks(["frontend"]);
  assert.deepEqual(evaluateSpecialistEvidence(frontend, {}).failures, [
    "Frontend Engineering requires browser evidence, but none was captured.",
  ]);
  assert.equal(evaluateSpecialistEvidence(frontend, { browserEvidence: { passed: false } }).passed, false);
  assert.equal(evaluateSpecialistEvidence(frontend, { browserEvidence: { passed: true } }).passed, true);
  assert.equal(evaluateSpecialistEvidence(selectSpecialistPacks(["backend"]), {}).passed, true);
});

test("team policy loads role and discipline model overrides", () => {
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
      disciplines: {
        security: { model: "security-local" },
      },
    }));

    const service = new TeamPolicyService();
    const policy = service.load(root);
    assert.equal(policy.defaultDiscipline, "backend");
    assert.equal(service.modelFor(policy, "architect", "fallback"), "architect-local");
    assert.equal(service.modelFor(policy, "implementer", "fallback"), "fallback");
    assert.equal(service.modelFor(policy, "implementer", "fallback", "security"), "security-local");
    assert.equal(service.modelFor(policy, "reviewer", "fallback", "backend"), "reviewer-local");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
