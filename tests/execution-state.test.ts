import test from "node:test";
import assert from "node:assert/strict";
import { buildRepairContext, executionAllowsTool, formatRepairContext, parseVerificationErrors } from "../packages/core/src/execution-state.ts";

test("durable implementation phase permits approved mutation while missing phase fails closed", () => {
  assert.equal(executionAllowsTool("IMPLEMENTING", "implementation", "worktree_patch"), true);
  assert.equal(executionAllowsTool("IMPLEMENTING", null, "worktree_patch"), true);
  assert.equal(executionAllowsTool("IMPLEMENTING", null, "repository_list"), false);
  assert.equal(executionAllowsTool("IMPLEMENTING", "technical_repair", "repository_list"), false);
  assert.equal(executionAllowsTool("IMPLEMENTING", "technical_repair", "worktree_patch"), true);
  assert.equal(executionAllowsTool("IMPLEMENTING", "design_refinement", "worktree_patch"), true);
});

test("verification and review phases cannot mutate source", () => {
  assert.equal(executionAllowsTool("VERIFYING", null, "worktree_patch"), false);
  assert.equal(executionAllowsTool("VERIFYING", null, "verification_run"), true);
  assert.equal(executionAllowsTool("VERIFYING", null, "browser_responsive"), true);
  assert.equal(executionAllowsTool("REVIEWING", null, "git_diff"), true);
  assert.equal(executionAllowsTool("REVIEWING", null, "worktree_patch"), false);
});

test("TypeScript evidence produces a compact implicated-file repair context", () => {
  const results = [{ label: "npm run build", command: "npm", args: ["run", "build"], exitCode: 2, stdout: "src/components/layout/Header.tsx(21,56): error TS2345: RefObject<HTMLDivElement | null> is not assignable", stderr: "" }];
  const errors = parseVerificationErrors(results);
  assert.equal(errors[0]?.file, "src/components/layout/Header.tsx");
  assert.equal(errors[0]?.code, "TS2345");
  const context = buildRepairContext({ sliceId: "homepage-shell", attempt: 0, results, recentChanges: ["src/components/layout/Header.tsx", "src/App.tsx"] });
  assert.deepEqual(context.implicatedFiles, ["src/components/layout/Header.tsx"]);
  assert.equal(context.classification, "type");
  const prompt = formatRepairContext(context);
  assert.match(prompt, /REPAIR 1/);
  assert.match(prompt, /Header\.tsx:21:56/);
  assert.doesNotMatch(prompt, /brief\.md|plan\.md|design brief/i);
});
