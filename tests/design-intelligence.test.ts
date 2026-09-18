import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DesignBriefSchema,
  DesignDirectorService,
  VisualDirectorService,
  designBriefPrompt,
  designDimensions,
  requiresDesignDirection,
} from "../packages/design-intelligence/src/index.ts";

function brief() {
  return DesignBriefSchema.parse({
    taskId: "task-design",
    createdAt: "2026-09-18T12:00:00.000Z",
    audience: "Homeowners seeking a premium remodeling firm",
    primaryPromise: "Make complex renovation work feel calm, precise, and trustworthy.",
    brandCharacter: ["architectural", "restrained", "warm"],
    visualDirection: "Editorial residential architecture with strong image-led rhythm and restrained detailing.",
    typography: {
      display: "High-contrast editorial display face",
      body: "Neutral grotesk",
      hierarchy: "Oversized display headlines with quiet utility text and clear contrast between levels.",
    },
    palette: [
      { role: "ink", direction: "charcoal" },
      { role: "paper", direction: "warm ivory" },
      { role: "accent", direction: "muted brass" },
    ],
    sections: [
      { purpose: "Hero", composition: "Asymmetric editorial split", visualWeight: "high-impact" },
      { purpose: "Services", composition: "Alternating editorial rows", visualWeight: "balanced" },
      { purpose: "CTA", composition: "Quiet full-width closing statement", visualWeight: "quiet" },
    ],
    motion: ["Use restrained entrance motion only when it reinforces hierarchy."],
    mobileStrategy: ["Recompose the hero rather than merely stacking it.", "Preserve display hierarchy with deliberate crop and spacing changes."],
    contentVoice: ["Specific and confident.", "Never use vague AI marketing filler."],
    avoid: ["Repetitive card grids", "Centered everything", "Arbitrary gradients", "Fake metrics", "Excessive pills"],
    qualityBar: ["Strong focal point", "Deliberate hierarchy", "Credible copy", "Intentional mobile composition", "Varied section rhythm"],
  });
}

test("design direction is required for greenfield BORG sites and visual website work", () => {
  assert.equal(requiresDesignDirection({
    request: "Build the homepage",
    disciplines: ["frontend"],
    isBorgWebsite: true,
  }), true);
  assert.equal(requiresDesignDirection({
    request: "Redesign the marketing landing page",
    disciplines: ["frontend"],
    isBorgWebsite: false,
  }), true);
  assert.equal(requiresDesignDirection({
    request: "Fix the click handler on this button",
    disciplines: ["frontend"],
    isBorgWebsite: false,
  }), false);
  assert.equal(requiresDesignDirection({
    request: "Fix the click handler on this button",
    disciplines: ["frontend"],
    isBorgWebsite: true,
  }), false);
  assert.equal(requiresDesignDirection({
    request: "Build a database migration",
    disciplines: ["backend", "database"],
    isBorgWebsite: false,
  }), false);
});

test("design brief prompt becomes a concrete implementation contract", () => {
  const value = designBriefPrompt(brief());
  assert.match(value, /APPROVED DESIGN DIRECTION/);
  assert.match(value, /Asymmetric editorial split/);
  assert.match(value, /Recompose the hero/);
  assert.match(value, /Repetitive card grids/);
  assert.match(value, /Strong focal point/);
});

test("design brief rejects weak incomplete art direction", () => {
  assert.throws(() => DesignBriefSchema.parse({
    taskId: "task-design",
    createdAt: "2026-09-18T12:00:00.000Z",
    audience: "Everyone",
  }));
});


test("design director returns a structured brief and preserves mandatory anti-patterns", async () => {
  const originalFetch = globalThis.fetch;
  let requestedModel = "";
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    requestedModel = body.model ?? "";
    return new Response(JSON.stringify({
      message: {
        content: JSON.stringify({
          audience: "Design-conscious homeowners",
          primaryPromise: "A calm, precise renovation experience.",
          brandCharacter: ["architectural", "warm", "restrained"],
          visualDirection: "Editorial architecture with asymmetric composition.",
          typography: { display: "High contrast display", body: "Neutral grotesk", hierarchy: "Large display, compact utility labels, readable body copy." },
          palette: [
            { role: "ink", direction: "charcoal" },
            { role: "paper", direction: "ivory" },
            { role: "accent", direction: "muted brass" },
          ],
          sections: [
            { purpose: "Hero", composition: "Asymmetric split", visualWeight: "high-impact" },
            { purpose: "Services", composition: "Editorial rows", visualWeight: "balanced" },
            { purpose: "CTA", composition: "Quiet closing statement", visualWeight: "quiet" },
          ],
          motion: ["Restrained entrance motion"],
          mobileStrategy: ["Recompose hero geometry", "Preserve hierarchy without simple stacking"],
          contentVoice: ["Specific", "Confident"],
          avoid: ["Fake metrics", "Generic claims", "Crowded layout", "Random shadows", "Decorative motion"],
          qualityBar: ["Strong hierarchy", "Distinct composition", "Credible copy", "Intentional mobile layout", "Consistent rhythm"],
        }),
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await new DesignDirectorService("http://127.0.0.1:11434").createBrief({
      taskId: "task-design-director",
      request: "Build a premium renovation homepage",
      model: "fake-coder",
      repositoryContext: "React app",
      isGreenfield: true,
    });
    assert.equal(requestedModel, "fake-coder");
    assert.match(result.visualDirection, /Editorial architecture/);
    assert.ok(result.avoid.some((item) => /centered-everything/i.test(item)));
    assert.ok(result.avoid.some((item) => /testimonials/i.test(item)));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("visual director can reject a technically valid page on aesthetic dimensions", async () => {
  const root = mkdtempSync(join(tmpdir(), "borg-design-review-"));
  const evidenceRoot = join(root, ".borg", "evidence", "browser");
  mkdirSync(evidenceRoot, { recursive: true });
  const mobileBytes = Buffer.from("mobile-image");
  const desktopBytes = Buffer.from("desktop-image");
  writeFileSync(join(evidenceRoot, "mobile.png"), mobileBytes);
  writeFileSync(join(evidenceRoot, "desktop.png"), desktopBytes);
  const mobileHash = createHash("sha256").update(mobileBytes).digest("hex");
  const desktopHash = createHash("sha256").update(desktopBytes).digest("hex");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/tags")) return new Response(JSON.stringify({ models: [{ name: "fake-vision" }] }), { status: 200 });
    const dimensions = designDimensions.map((dimension, index) => ({
      dimension,
      verdict: index === 3 ? "repair" : "pass",
      evidence: index === 3 ? "The page repeats the same centered card composition." : "The screenshot supports this dimension.",
      recommendation: index === 3 ? "Introduce an asymmetric editorial section and stronger focal point." : "Keep the current direction.",
    }));
    return new Response(JSON.stringify({
      message: {
        content: JSON.stringify({
          verdict: "repair",
          summary: "Functional, but the composition still looks generic.",
          dimensions,
          findings: [{
            screenshotIndex: 1,
            severity: "medium",
            category: "composition",
            title: "Repetitive centered composition",
            description: "The desktop layout repeats the same centered structure.",
            evidence: "Multiple consecutive sections share identical alignment and geometry.",
            remediation: "Recompose at least one major section around an asymmetric focal point.",
            confidence: 0.93,
          }],
        }),
      },
    }), { status: 200 });
  };
  try {
    const review = await new VisualDirectorService("http://127.0.0.1:11434").review({
      taskId: "task-visual-director",
      request: "Build a premium renovation homepage",
      worktreePath: root,
      brief: brief(),
      policy: {
        enabled: false,
        provider: "ollama",
        model: "fake-vision",
        maxScreenshots: 3,
        timeoutMs: 60000,
        blockingSeverity: "high",
        updatedAt: "2026-09-18T12:00:00.000Z",
      },
      browserEvidence: {
        taskId: "task-visual-director",
        passed: true,
        issues: [],
        url: "http://127.0.0.1:5173/",
        viewport: { width: 1440, height: 1000 },
        capturedAt: "2026-09-18T12:00:00.000Z",
        dom: [],
        console: [],
        network: [],
        accessibility: { violations: [], incomplete: 0, passes: 10 },
        screenshots: [],
        responsive: [
          { name: "mobile", width: 390, height: 844, url: "http://127.0.0.1:5173/", title: "Site", screenshot: { name: "mobile", path: ".borg/evidence/browser/mobile.png", sha256: mobileHash, width: 390, height: 844, fullPage: true }, accessibility: null },
          { name: "desktop", width: 1440, height: 1000, url: "http://127.0.0.1:5173/", title: "Site", screenshot: { name: "desktop", path: ".borg/evidence/browser/desktop.png", sha256: desktopHash, width: 1440, height: 1000, fullPage: true }, accessibility: null },
        ],
        server: null,
      },
    });
    assert.equal(review.status, "repair");
    assert.equal(review.dimensions.length, designDimensions.length);
    assert.equal(review.findings[0]?.category, "design/composition");
    assert.match(review.summary, /generic/);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});
