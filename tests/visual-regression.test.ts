import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BrowserEvidenceReport } from "../packages/browser-verification/src/index.ts";
import {
  VisualRegressionService,
  comparePng,
  decodePng,
  encodePng,
} from "../packages/visual-regression/src/index.ts";

function solid(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    data.set(rgba, pixel * 4);
  }
  return encodePng({ width, height, data });
}

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function evidence(path: string, bytes: Buffer, width: number, height: number): BrowserEvidenceReport {
  return {
    taskId: "visual-task",
    passed: true,
    issues: [],
    url: "http://127.0.0.1:5173/",
    viewport: { width, height },
    capturedAt: new Date().toISOString(),
    dom: [],
    console: [],
    network: [],
    accessibility: null,
    screenshots: [{ name: "responsive-mobile", path, sha256: hash(bytes), width, height, fullPage: true }],
    responsive: [],
    server: null,
  };
}

test("PNG codec produces deterministic pixels and ignored-region diffs", () => {
  const baselineBytes = solid(2, 1, [10, 20, 30, 255]);
  const candidate = decodePng(Buffer.from(baselineBytes));
  candidate.data.set([255, 255, 255, 255], 0);
  const comparison = comparePng(decodePng(baselineBytes), candidate, 0.1, [{ x: 0, y: 0, width: 1, height: 1 }]);
  assert.equal(comparison.changedPixels, 0);
  assert.equal(comparison.ignoredPixels, 1);
  assert.deepEqual(decodePng(comparison.diff).data.length, 8);
});

test("visual baselines require explicit acceptance before deterministic comparison", () => {
  const root = mkdtempSync(join(tmpdir(), "borg-visual-"));
  const screenshotPath = ".borg/evidence/browser/mobile.png";
  const absolute = join(root, screenshotPath);
  mkdirSync(join(root, ".borg/evidence/browser"), { recursive: true });
  mkdirSync(join(root, ".localcode"), { recursive: true });
  writeFileSync(join(root, ".localcode/visual-regression.json"), JSON.stringify({
    version: 1,
    profiles: [{
      id: "app",
      verificationProfiles: ["quick"],
      screenshotNames: ["responsive-mobile"],
      pixelThreshold: 0.05,
      maxChangedPixelRatio: 0,
      maxChangedPixels: 0,
      ignoreRegions: [],
    }],
  }));
  const original = solid(2, 2, [20, 40, 60, 255]);
  writeFileSync(absolute, original);
  const service = new VisualRegressionService();
  try {
    const first = service.compare(root, evidence(screenshotPath, original, 2, 1), "quick");
    assert.equal(first.status, "missing-baseline");
    assert.equal(first.passed, false);
    const candidate = first.comparisons[0].candidate;
    assert.deepEqual({ width: candidate.width, height: candidate.height }, { width: 2, height: 2 });
    const accepted = service.acceptBaseline(root, {
      profileId: "app",
      screenshotName: "responsive-mobile",
      candidatePath: candidate.path,
      candidateSha256: candidate.sha256,
      width: 2,
      height: 2,
    });
    assert.equal(accepted.path, ".localcode/visual-baselines/app/responsive-mobile.png");

    const passing = service.compare(root, evidence(screenshotPath, original, 2, 2), "quick");
    assert.equal(passing.status, "pass");
    assert.equal(passing.comparisons[0].changedPixels, 0);
    assert.ok(passing.comparisons[0].diff?.path.endsWith("-diff.png"));

    const changed = decodePng(original);
    changed.data.set([255, 0, 0, 255], 0);
    const changedBytes = encodePng(changed);
    writeFileSync(absolute, changedBytes);
    const regression = service.compare(root, evidence(screenshotPath, changedBytes, 2, 2), "quick");
    assert.equal(regression.status, "regression");
    assert.equal(regression.passed, false);
    assert.equal(regression.comparisons[0].changedPixels, 1);

    writeFileSync(absolute, solid(3, 2, [20, 40, 60, 255]));
    const resized = readFileSync(absolute);
    const mismatch = service.compare(root, evidence(screenshotPath, resized, 3, 2), "quick");
    assert.equal(mismatch.status, "dimension-mismatch");
    assert.equal(mismatch.passed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("visual comparison rejects candidates whose browser hash was tampered", () => {
  const root = mkdtempSync(join(tmpdir(), "borg-visual-"));
  const screenshotPath = ".borg/evidence/browser/mobile.png";
  mkdirSync(join(root, ".borg/evidence/browser"), { recursive: true });
  mkdirSync(join(root, ".localcode"), { recursive: true });
  writeFileSync(join(root, ".localcode/visual-regression.json"), JSON.stringify({
    version: 1,
    profiles: [{ id: "app", verificationProfiles: ["quick"] }],
  }));
  const bytes = solid(1, 1, [0, 0, 0, 255]);
  writeFileSync(join(root, screenshotPath), bytes);
  const reportEvidence = evidence(screenshotPath, bytes, 1, 1);
  reportEvidence.screenshots[0].sha256 = "a".repeat(64);
  try {
    const report = new VisualRegressionService().compare(root, reportEvidence, "quick");
    assert.equal(report.status, "failed");
    assert.match(report.comparisons[0].message, /hash no longer matches/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
