import test from "node:test";
import assert from "node:assert/strict";
import {
  ProjectComponentSchema,
  ProjectPageSchema,
  ProjectPlanSchema,
  ProjectSliceSchema,
  ProjectStyleSystemSchema,
} from "../packages/core/src/project-domain.ts";
import {
  WorkflowPlannedComponentSchema,
  WorkflowProjectPlanSchema,
  WorkflowProjectSliceSchema,
  WorkflowSitemapPageSchema,
  WorkflowStyleSystemSchema,
} from "../packages/core/src/contracts.ts";

test("workflow contracts reuse the canonical project domain schemas", () => {
  assert.equal(WorkflowProjectSliceSchema, ProjectSliceSchema);
  assert.equal(WorkflowSitemapPageSchema, ProjectPageSchema);
  assert.equal(WorkflowPlannedComponentSchema, ProjectComponentSchema);
  assert.equal(WorkflowStyleSystemSchema, ProjectStyleSystemSchema);
  assert.equal(WorkflowProjectPlanSchema, ProjectPlanSchema);
});

test("canonical project plan normalizes legacy workflow snapshots", () => {
  const plan = ProjectPlanSchema.parse({
    version: 2,
    revision: 1,
    status: "proposed",
    phase: "frontend",
    siteGoal: "Build a site",
    audience: "Customers",
    pages: ["Home"],
    features: ["Navigation"],
    visualDirection: "Editorial",
    backendRequired: false,
    slices: [{ id: "home", title: "Homepage", outcome: "Homepage works", scope: ["home"], acceptanceCriteria: ["Responsive"] }],
    acceptanceCriteria: ["Responsive"],
    proposedAt: new Date().toISOString(),
    approvedAt: null,
  });

  assert.deepEqual(plan.sitemap, []);
  assert.deepEqual(plan.components, []);
  assert.equal(plan.styles.direction, "");
});

test("canonical page and component models validate shared project vocabulary", () => {
  const page = ProjectPageSchema.parse({
    id: "home",
    name: "Home",
    route: "/",
    purpose: "Primary route",
    sections: ["Hero"],
    componentIds: ["hero"],
    acceptanceCriteria: ["Hero is visible"],
  });
  const component = ProjectComponentSchema.parse({
    id: "hero",
    name: "Hero",
    kind: "section",
    purpose: "Primary value proposition",
    usedBy: ["home"],
    variants: ["desktop", "mobile"],
    acceptanceCriteria: ["Responsive"],
  });

  assert.equal(page.componentIds[0], component.id);
  assert.throws(() => ProjectPageSchema.parse({ ...page, route: "home" }));
});
