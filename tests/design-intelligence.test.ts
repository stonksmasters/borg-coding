import assert from "node:assert/strict";
import test from "node:test";
import {
  DesignBriefSchema,
  designBriefPrompt,
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
