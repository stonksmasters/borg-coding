import test from "node:test";
import assert from "node:assert/strict";
import { assertExecutionTransition, buildRepairContext, executionAllowsTool, formatRepairContext, parseVerificationErrors } from "../packages/core/src/execution-state.ts";

test("repair state rejects a restart into implementation", () => {
  assert.throws(() => assertExecutionTransition("REPAIR", "IMPLEMENT"), /Invalid execution transition/);
  assert.doesNotThrow(() => assertExecutionTransition("REPAIR", "VERIFY"));
});

test("repair tools exclude broad repository discovery and verification mutation", () => {
  assert.equal(executionAllowsTool("REPAIR", "repository_list"), false);
  assert.equal(executionAllowsTool("REPAIR", "repository_search"), false);
  assert.equal(executionAllowsTool("REPAIR", "worktree_patch"), true);
  assert.equal(executionAllowsTool("VERIFY", "worktree_patch"), false);
  assert.equal(executionAllowsTool("VERIFY", "verification_run"), true);
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
