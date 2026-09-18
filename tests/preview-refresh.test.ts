import assert from "node:assert/strict";
import test from "node:test";
import { previewChangeFingerprint, shouldRefreshPreview } from "../app/preview-refresh.ts";

const clean = { clean: true, diff: "", files: [] };

test("preview does not refresh while establishing the initial worktree baseline", () => {
  const fingerprint = previewChangeFingerprint(clean);
  assert.equal(fingerprint, "clean");
  assert.equal(shouldRefreshPreview(null, fingerprint), false);
});

test("preview refreshes only when the confirmed Git change set changes", () => {
  const previous = previewChangeFingerprint(clean);
  const changed = previewChangeFingerprint({
    clean: false,
    diff: "diff --git a/src/main.tsx b/src/main.tsx\n+updated",
    files: [{ path: "src/main.tsx", previousPath: null, status: "modified", additions: 1, deletions: 0 }],
  });
  assert.equal(shouldRefreshPreview(previous, changed), true);
  assert.equal(shouldRefreshPreview(changed, changed), false);
});
