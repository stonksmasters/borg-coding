import assert from "node:assert/strict";
import test from "node:test";
import { classifyImplementationFailure, classifyObservedToolFailures, compactRecoveryEvidence } from "../apps/server/src/recovery-policy.ts";
import type { WorkspacePreflightReport } from "../packages/web-builder/src/workspace-preflight.ts";

test("recovery policy classifies bounded implementation mistakes as recoverable", () => {
  const cases = [
    ["ENOENT: no such file or directory, open src/features/cart/Cart.tsx", "missing_path"],
    ["Patch expected 1 replacement(s) but found 0.", "patch_mismatch"],
    ["listen EADDRINUSE: address already in use 127.0.0.1:5173", "port_conflict"],
    ["Preview process exited unexpectedly.", "process_interrupted"],
    ["Cannot find module './CheckoutPanel'", "missing_reference"],
    ["Worktree file already exists. Set overwrite=true to replace it.", "tool_usage"],
    ['Tool usage error: npm script "test" is not defined in package.json.', "tool_usage"],
  ] as const;

  for (const [message, category] of cases) {
    const decision = classifyImplementationFailure(message, 0, 2);
    assert.equal(decision.disposition, "retry", message);
    assert.equal(decision.category, category, message);
  }
});

test("recovery policy treats safety and repository boundary violations as fatal", () => {
  const cases = [
    ["Unsafe worktree path.", "path_escape"],
    ["The task does not have an approved worktree.", "approval_violation"],
    ["fatal: not a git repository", "repository_invalid"],
    ["EACCES: permission denied", "permission_denied"],
  ] as const;

  for (const [message, category] of cases) {
    const decision = classifyImplementationFailure(message, 0, 2);
    assert.equal(decision.disposition, "fatal", message);
    assert.equal(decision.category, category, message);
  }
});

test("unknown no-progress attempts get one bounded retry while unknown runtime failures stop", () => {
  const noProgress = classifyImplementationFailure("The model returned without touching source.", 0, 2, { noProgress: true });
  assert.equal(noProgress.disposition, "retry");
  assert.equal(noProgress.category, "no_progress");

  const unknown = classifyImplementationFailure("Completely unexpected invariant failure", 0, 2);
  assert.equal(unknown.disposition, "fatal");
  assert.equal(unknown.category, "unknown");

  const exhausted = classifyImplementationFailure("ENOENT: missing file", 2, 2);
  assert.equal(exhausted.disposition, "fatal");
  assert.equal(exhausted.category, "retry_exhausted");
});

test("compact recovery evidence preserves only the current failure and deterministic preflight state", () => {
  const decision = classifyImplementationFailure("ENOENT: missing nested folder", 0, 2);
  const preflight: WorkspacePreflightReport = {
    root: "/tmp/worktree",
    reason: "no_progress_recovery",
    contract: {
      kind: "vite-react",
      directories: ["src", "src/features", ".localcode/build"],
      requiredFiles: ["package.json"],
      sourceRoots: ["src"],
      expectedPackages: ["vite", "react"],
      expectedScripts: ["dev", "build"],
    },
    passed: true,
    repairedDirectories: ["src/features"],
    issues: [
      { code: "directory_repaired", severity: "repair", message: "Recreated src/features" },
      { code: "dependency_install_missing", severity: "warning", message: "node_modules is missing" },
    ],
    gitHead: "abc123",
    dependencyState: "install_missing",
  };
  const text = compactRecoveryEvidence(decision, preflight, ["first failure", "ENOENT: missing nested folder"]);
  assert.match(text, /SAME approved slice/);
  assert.match(text, /vite-react/);
  assert.match(text, /src\/features/);
  assert.match(text, /abc123/);
  assert.match(text, /node_modules is missing/);
  assert.doesNotMatch(text, /rediscover.*whole repository/i);
});



test("observed tool failures prioritize concrete safety and recovery evidence over generic no-progress", () => {
  const missing = classifyObservedToolFailures(
    ["ENOENT: no such file or directory, realpath src/features/recovery/Missing.tsx"],
    0,
    2,
    "No source progress.",
  );
  assert.equal(missing.disposition, "retry");
  assert.equal(missing.category, "missing_path");

  const escape = classifyObservedToolFailures(
    ["Unsafe worktree path.", "Blocked repeated identical tool call."],
    0,
    2,
    "No source progress.",
  );
  assert.equal(escape.disposition, "fatal");
  assert.equal(escape.category, "path_escape");

  const fallback = classifyObservedToolFailures([], 0, 2, "No source progress.");
  assert.equal(fallback.disposition, "retry");
  assert.equal(fallback.category, "no_progress");
});
