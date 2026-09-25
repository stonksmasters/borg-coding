import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { browserRepairSourceHints, compactBrowserRepairEvidence, ImplementationBudgetContinuations, isTransientModelRuntimeFailure, shouldVerifyPersistedRetryFirst, webInterfaceExecutionOrder } from "../apps/server/src/execution-grounding.ts";

test("web implementation order requires a runnable entrypoint-connected slice before extracted components", () => {
  assert.match(webInterfaceExecutionOrder, /package manifest and actual application entrypoint/i);
  assert.match(webInterfaceExecutionOrder, /replaces any starter placeholder/i);
  assert.match(webInterfaceExecutionOrder, /do not spend the attempt building detached components/i);
  assert.match(webInterfaceExecutionOrder, /render the actual entry route/i);
});

test("tool-budget continuation is bounded once per implementation or repair attempt", () => {
  const continuations = new ImplementationBudgetContinuations();

  assert.equal(continuations.claim(0, "implementation"), true);
  assert.equal(continuations.claim(0, "implementation"), false);
  assert.equal(continuations.claim(1, "technical_repair"), true);
  assert.equal(continuations.claim(1, "technical_repair"), false);
  assert.equal(continuations.claim(2, "technical_repair"), true);
});

test("browser repair evidence prioritizes actionable failures over the full DOM", () => {
  const compact = compactBrowserRepairEvidence({
    passed: false,
    issues: ["Visible controls have no action."],
    url: "http://127.0.0.1:5173/",
    accessibility: { violations: [{ id: "button-name", impact: "critical" }] },
    dom: [{ text: "x".repeat(20_000) }],
    responsive: [{ name: "mobile", width: 390, height: 844, accessibility: { violations: [{ id: "color-contrast" }], incomplete: 0 } }],
  }, { passed: false, failures: ["Browser evidence did not pass."] });

  assert.match(compact, /button-name/);
  assert.match(compact, /color-contrast/);
  assert.match(compact, /Visible controls have no action/);
  assert.doesNotMatch(compact, /"dom"/);
});

test("accessibility evidence points repairs at the changed source that rendered the failing element", () => {
  const root = mkdtempSync(join(tmpdir(), "borg-repair-hints-"));
  try {
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    mkdirSync(join(root, "src", "sections"), { recursive: true });
    writeFileSync(join(root, "src", "sections", "Filters.tsx"), [
      "export function Filters() {",
      "  return <select className=\"px-4 py-2 border border-gray-300 rounded-lg\">",
      "    <option>All categories</option>",
      "  </select>;",
      "}",
    ].join("\n"));
    const hints = browserRepairSourceHints(root, {
      accessibility: { violations: [{ nodes: [{ html: '<select class="px-4 py-2 border border-gray-300 rounded-lg">' }] }] },
    });
    assert.match(hints, /src\/sections\/Filters\.tsx:2/);
    assert.match(hints, /All categories/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("transient local-model transport failures are distinguished from invariant failures", () => {
  assert.equal(isTransientModelRuntimeFailure(new Error("Ollama returned 500")), true);
  assert.equal(isTransientModelRuntimeFailure("fetch failed"), true);
  assert.equal(isTransientModelRuntimeFailure("Unsafe worktree path"), false);
  assert.equal(isTransientModelRuntimeFailure("Completely unexpected invariant failure"), false);
});

test("blocked retries verify saved work before reconnecting to a failed model runtime", () => {
  assert.equal(shouldVerifyPersistedRetryFirst({ blockedRetry: true, failure: "fetch failed", changedPaths: ["src/App.tsx"] }), true);
  assert.equal(shouldVerifyPersistedRetryFirst({ blockedRetry: true, failure: "fetch failed", changedPaths: [] }), false);
  assert.equal(shouldVerifyPersistedRetryFirst({ blockedRetry: false, failure: "fetch failed", changedPaths: ["src/App.tsx"] }), false);
  assert.equal(shouldVerifyPersistedRetryFirst({ blockedRetry: true, failure: "Unsafe worktree path", changedPaths: ["src/App.tsx"] }), false);
});
