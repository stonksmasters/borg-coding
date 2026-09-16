import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BrowserEvidenceReport } from "../packages/browser-verification/src/index.ts";
import {
  VisionReviewService,
  VisionUnavailableError,
  parseVisionResponse,
  type VisionImage,
  type VisionReviewProvider,
  type VisionReviewRequest,
  type VisionReviewResult,
} from "../packages/vision-review/src/index.ts";

function visionImage(): VisionImage {
  return {
    path: ".borg/evidence/browser/mobile.png",
    sha256: "a".repeat(64),
    width: 390,
    height: 844,
    base64: "aW1hZ2U=",
    mimeType: "image/png",
  };
}

function evidence(path: string, sha256: string): BrowserEvidenceReport {
  return {
    taskId: "task-vision",
    passed: true,
    issues: [],
    url: "http://127.0.0.1:5173/",
    viewport: { width: 390, height: 844 },
    capturedAt: new Date().toISOString(),
    dom: [{
      selector: "#submit", tag: "button", role: "button", name: "Submit", text: "Submit",
      href: null, disabled: false, visible: true, rect: { x: 20, y: 700, width: 120, height: 40 },
    }],
    console: [],
    network: [],
    accessibility: { violations: [], incomplete: 0, passes: 12 },
    screenshots: [{ name: "mobile", path, sha256, width: 390, height: 844, fullPage: true }],
    responsive: [],
    server: null,
  };
}

test("vision responses retain screenshot provenance and escalate blocking severity", () => {
  const result = parseVisionResponse("task-vision", "qwen3-vl:8b", [visionImage()], JSON.stringify({
    verdict: "pass",
    summary: "The primary action is clipped.",
    findings: [{
      screenshotIndex: 0,
      severity: "high",
      category: "overflow",
      title: "Submit button is clipped",
      description: "The action extends beyond the mobile viewport.",
      evidence: "Only the left portion of the button is visible.",
      remediation: "Remove the fixed width and allow the action row to wrap.",
      confidence: 0.94,
      selector: "#submit",
    }],
  }), "high");
  assert.equal(result.status, "repair");
  assert.equal(result.findings[0].screenshotSha256, "a".repeat(64));
  assert.deepEqual(result.findings[0].viewport, { width: 390, height: 844 });
  assert.equal(result.findings[0].confidence, 0.94);
  assert.equal(result.findings[0].selector, "#submit");
});

test("vision review reads only hash-matched screenshots inside the worktree", async () => {
  const root = mkdtempSync(join(tmpdir(), "borg-vision-"));
  const screenshotPath = ".borg/evidence/browser/mobile.png";
  const absolute = join(root, screenshotPath);
  mkdirSync(join(root, ".borg/evidence/browser"), { recursive: true });
  const bytes = Buffer.from("bounded-test-image");
  writeFileSync(absolute, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const captured: { request?: VisionReviewRequest } = {};
  const provider: VisionReviewProvider = {
    async review(request) {
      captured.request = request;
      return {
        taskId: request.taskId,
        status: "pass",
        summary: "No visible defects.",
        findings: [],
        provider: "ollama",
        model: request.model,
        reviewedAt: new Date().toISOString(),
        screenshots: request.images.map(({ path, sha256: hash, width, height }) => ({ path, sha256: hash, width, height })),
      };
    },
  };
  const service = new VisionReviewService(join(root, ".borg/vision.json"), provider);
  service.save({ enabled: true, model: "qwen3-vl:8b", maxScreenshots: 1, blockingSeverity: "high" });
  try {
    const result = await service.review({
      taskId: "task-vision",
      request: "Check the mobile page",
      worktreePath: root,
      browserEvidence: evidence(screenshotPath, sha256),
    });
    assert.equal(result.status, "pass");
    assert.equal(captured.request?.images[0].sha256, sha256);
    assert.equal(captured.request?.images[0].base64, bytes.toString("base64"));

    await assert.rejects(() => service.review({
      taskId: "task-vision",
      request: "Check the mobile page",
      worktreePath: root,
      browserEvidence: evidence(screenshotPath, "b".repeat(64)),
    }), /hash no longer matches/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unavailable vision models are explicit and do not throw", async () => {
  const root = mkdtempSync(join(tmpdir(), "borg-vision-"));
  const screenshotPath = ".borg/evidence/browser/mobile.png";
  const absolute = join(root, screenshotPath);
  mkdirSync(join(root, ".borg/evidence/browser"), { recursive: true });
  const bytes = Buffer.from("bounded-test-image");
  writeFileSync(absolute, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const provider: VisionReviewProvider = {
    async review(): Promise<VisionReviewResult> {
      throw new VisionUnavailableError("qwen3-vl:8b is not installed.");
    },
  };
  const service = new VisionReviewService(join(root, ".borg/vision.json"), provider);
  service.save({ enabled: true, model: "qwen3-vl:8b" });
  try {
    const result = await service.review({
      taskId: "task-vision",
      request: "Check the page",
      worktreePath: root,
      browserEvidence: evidence(screenshotPath, sha256),
    });
    assert.equal(result.status, "unavailable");
    assert.match(result.summary, /not installed/);
    assert.equal(result.findings.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
