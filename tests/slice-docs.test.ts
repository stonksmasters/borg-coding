import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowStateSchema } from "../packages/core/src/contracts.ts";
import {
  approveProjectPlan,
  fallbackProjectPlan,
  extractExplicitPageRequirements,
  markSliceReady,
  parseProjectPlan,
  parseProjectPlanResult,
  validateProjectPlanCoverage,
  persistDesignBrief,
  persistProposedProjectPlan,
  prepareSlice,
  projectDeliveredFrontendCheckpoint,
  readFrontendWorkflowState,
  readPersistedDesignBrief,
  readProjectDocs,
  readProjectPlan,
  readSliceState,
  slicePlanningPrompt,
  slicePrompt,
} from "../packages/web-builder/src/slice-docs.ts";

test("website types receive appropriately sized fallback phase plans", () => {
  const landing = fallbackProjectPlan("A premium landing page with pricing and a waitlist.", "saas-landing");
  const content = fallbackProjectPlan("A content site with articles, categories, and search.", "portfolio");
  const ecommerce = fallbackProjectPlan("An ecommerce store with cart and checkout.", "ecommerce");
  const dashboard = fallbackProjectPlan("An authenticated operations dashboard with stored records.", "dashboard");

  assert.ok(landing.slices.length >= 4 && landing.slices.length <= 5);
  assert.ok(content.slices.length >= 4 && content.slices.length <= 5);
  assert.match(landing.slices[0].title, /hero/i);
  assert.match(landing.slices[1].title, /homepage/i);
  assert.ok(ecommerce.slices.length >= landing.slices.length);
  assert.ok(dashboard.slices.length >= 3);
  assert.doesNotMatch(dashboard.slices.map((slice) => slice.title).join(" | "), /homepage|hero/i);
  assert.equal(landing.backendRequired, false);
  assert.equal(ecommerce.backendRequired, true);
  assert.equal(dashboard.backendRequired, true);
  assert.ok(landing.sitemap.length >= 1);
  assert.equal(landing.sitemap[0].route, "/");
  assert.ok(landing.components.length >= 3);
  assert.ok(landing.styles.typography.length > 0);
  assert.ok(ecommerce.sitemap.some((page) => page.route === "/checkout"));
  assert.ok(ecommerce.components.some((component) => component.usedBy.length > 0));
});

test("operations fallback preserves explicit ForgeOps page coverage and application slices", () => {
  const brief = "Build ForgeOps, an internal operations dashboard. At minimum: Overview, Schedule, Jobs, Job Detail, Customers, Customer Detail, Technicians, Technician Detail, Vehicles, Inventory, Reports, and Settings.";
  const required = extractExplicitPageRequirements(brief);
  assert.deepEqual(required, ["Overview", "Schedule", "Jobs", "Job Detail", "Customers", "Customer Detail", "Technicians", "Technician Detail", "Vehicles", "Inventory", "Reports", "Settings"]);

  const plan = fallbackProjectPlan(brief, "dashboard");
  assert.equal(plan.sitemap.length, 12);
  for (const page of required) assert.ok(plan.sitemap.some((item) => item.name === page), `missing ${page}`);
  assert.doesNotMatch(plan.slices.map((slice) => [slice.title, ...slice.scope].join(" ")).join(" | "), /homepage|hero|marketing/i);
  assert.equal(validateProjectPlanCoverage(plan, brief).valid, true);
});

test("complex application plans that omit required screens request a bounded planning retry", () => {
  const brief = "Build ForgeOps. Required pages: Overview, Schedule, Jobs, Customers, Technicians, Vehicles, Inventory, Reports, Settings.";
  const answer = `<borg-project-plan>{"siteGoal":"ForgeOps","audience":"Dispatchers","sitemap":[{"id":"overview","name":"Overview","route":"/","purpose":"Overview","sections":[],"componentIds":[],"acceptanceCriteria":[]},{"id":"schedule","name":"Schedule","route":"/schedule","purpose":"Schedule","sections":[],"componentIds":[],"acceptanceCriteria":[]}],"components":[],"styles":{},"visualDirection":"Dense operations UI","backendRequired":true,"slices":[{"id":"shell","title":"Overview","outcome":"Overview","scope":["Overview"],"acceptanceCriteria":[]},{"id":"schedule","title":"Schedule","outcome":"Schedule","scope":["Schedule"],"acceptanceCriteria":[]}],"acceptanceCriteria":[]}</borg-project-plan>`;
  const result = parseProjectPlanResult(answer, brief, "dashboard");
  assert.equal(result.source, "fallback");
  assert.equal(result.retryRecommended, true);
  assert.ok(result.validation.missingPages.includes("Jobs"));
  assert.match(result.fallbackReason ?? "", /Missing required sitemap pages/i);
  assert.equal(validateProjectPlanCoverage(result.plan, brief).valid, true);
});

test("software product and consumer experience briefs do not become commerce plans", () => {
  const nightlife = fallbackProjectPlan("Build a premium consumer product for discovering late-night experiences, events, rooftops, and neighborhoods.", "saas-landing");
  const agency = fallbackProjectPlan("Build a production-quality product development studio website with project case studies and services.", "saas-landing");

  assert.doesNotMatch(nightlife.slices[0].title, /commerce/i);
  assert.doesNotMatch(agency.slices[0].title, /commerce/i);
  assert.match(nightlife.slices[0].title, /hero/i);
  assert.match(agency.slices[0].title, /hero/i);
});

test("commerce fallback preserves vertical product slices when model formatting fails", () => {
  const plan = fallbackProjectPlan(
    "Build a social-commerce marketplace with discovery feed, product variants, cart, checkout, orders, auth, wishlist, sellers, inventory, and admin roles.",
    "ecommerce",
  );
  const titles = plan.slices.map((slice) => slice.title).join(" | ");
  assert.match(titles, /Commerce foundation/i);
  assert.match(titles, /Catalog, search, and product/i);
  assert.match(titles, /Cart and checkout/i);
  assert.match(titles, /account and order/i);
  assert.match(titles, /Social-commerce/i);
  assert.match(titles, /Seller storefront/i);
  assert.match(titles, /Administrator/i);
  assert.match(titles, /Frontend completion review/i);
  assert.equal(plan.backendRequired, true);
  assert.ok(plan.slices.length >= 8);
});

test("structured model plans replace the fixed slice list", () => {
  const answer = `Plan summary.
<borg-project-plan>{"siteGoal":"Launch a collector marketplace","audience":"Collectors","pages":["Home","Browse","Listing"],"features":["Search","Listing detail"],"sitemap":[{"id":"home","name":"Home","route":"/","purpose":"Introduce the marketplace","sections":["Navigation","Hero","Featured cards"],"componentIds":["site-header","product-card"],"acceptanceCriteria":["home works"]},{"id":"browse","name":"Browse","route":"/browse","purpose":"Discover cards","sections":["Search","Filters","Results"],"componentIds":["site-header","search-controls","product-card"],"acceptanceCriteria":["browse works"]},{"id":"listing","name":"Listing","route":"/cards/:id","purpose":"Inspect a card","sections":["Gallery","Details"],"componentIds":["site-header","card-detail"],"acceptanceCriteria":["listing works"]}],"components":[{"id":"site-header","name":"Site Header","kind":"layout","purpose":"Global navigation","usedBy":["home","browse","listing"],"variants":["desktop","mobile"],"acceptanceCriteria":["navigation works"]},{"id":"product-card","name":"Product Card","kind":"ui","purpose":"Reusable card summary","usedBy":["home","browse"],"variants":["featured","compact"],"acceptanceCriteria":["card is responsive"]},{"id":"search-controls","name":"Search Controls","kind":"feature","purpose":"Search and filter inventory","usedBy":["browse"],"variants":[],"acceptanceCriteria":["filters update results"]},{"id":"card-detail","name":"Card Detail","kind":"section","purpose":"Detailed listing presentation","usedBy":["listing"],"variants":[],"acceptanceCriteria":["details render"]}],"styles":{"direction":"Editorial dark collector experience","colors":["charcoal surfaces","warm paper text","electric accent"],"typography":["high contrast display","neutral body"],"spacing":["large editorial section rhythm"],"radii":["restrained radius scale"],"shadows":["minimal elevation"],"layoutPrinciples":["asymmetric editorial composition"],"motion":["restrained state motion"],"responsive":["recompose mobile layouts"],"accessibility":["visible focus","AA contrast"],"avoid":["generic card grids"]},"visualDirection":"Editorial dark","backendRequired":true,"slices":[{"id":"shell","title":"Shell","outcome":"Navigable shell","scope":["navigation"],"acceptanceCriteria":["mobile works"]},{"id":"browse","title":"Browse","outcome":"Browse works","scope":["catalog"],"acceptanceCriteria":["filters work"]},{"id":"review","title":"Review","outcome":"Frontend gate passes","scope":["browser review"],"acceptanceCriteria":["build passes"]}],"acceptanceCriteria":["all pages navigable"]}</borg-project-plan>`;
  const plan = parseProjectPlan(answer, "Build a marketplace", "ecommerce");
  assert.equal(plan.slices.length, 3);
  assert.equal(plan.slices[1].title, "Browse");
  assert.equal(plan.backendRequired, true);
  assert.equal(plan.siteGoal, "Launch a collector marketplace");
  assert.equal(plan.sitemap[1].route, "/browse");
  assert.deepEqual(plan.sitemap[1].componentIds, ["site-header", "search-controls", "product-card"]);
  assert.equal(plan.components.find((component) => component.id === "product-card")?.kind, "ui");
  assert.match(plan.styles.direction, /Editorial dark/);
});

test("project plan approval is separate from slice execution", () => {
  const root = mkdtempSync(join(tmpdir(), "borg-project-plan-"));
  try {
    const proposed = persistProposedProjectPlan(root, "Build a commerce app", fallbackProjectPlan("Build a commerce app", "ecommerce"), "planning-task");
    assert.equal(proposed.status, "proposed");
    assert.equal(readSliceState(root)?.status, "plan_pending");
    assert.ok(existsSync(join(root, ".localcode", "build", "state.md")));
    assert.equal(existsSync(join(root, ".localcode", "build", "state.json")), false);
    assert.ok(readProjectDocs(root).every((doc) => doc.path.endsWith(".md")));

    const approved = approveProjectPlan(root, "planning-task");
    assert.equal(approved.plan.status, "approved");
    assert.equal(approved.state.status, "ready");
    assert.equal(readFrontendWorkflowState(root)?.stage, "plan_approved");

    const designBrief = { taskId: "planning-task", createdAt: new Date().toISOString(), visualDirection: "Editorial premium" };
    persistDesignBrief(root, designBrief);
    assert.deepEqual(readPersistedDesignBrief(root), designBrief);
    assert.ok(readProjectDocs(root).some((doc) => doc.path.endsWith("/design-brief.md")));
    assert.ok(readProjectDocs(root).some((doc) => doc.path.endsWith("/site-map.md")));
    assert.ok(readProjectDocs(root).some((doc) => doc.path.endsWith("/components.md")));
    assert.ok(readProjectDocs(root).some((doc) => doc.path.endsWith("/styles.md")));

    const plan = readProjectPlan(root)!;
    const planPrompt = slicePlanningPrompt(plan, approved.state);
    assert.match(planPrompt, /MINI LOOP/);
    assert.match(planPrompt, /Do not rediscover the whole repository/i);
    assert.match(planPrompt, /internal execution loop/i);
    assert.match(planPrompt, /desktop runtime will authorize execution from the outer plan approval/i);
    assert.doesNotMatch(planPrompt, /request escalation to EDIT/i);

    const first = prepareSlice(root, "", "initial", "", "slice-one", "Patch the shell only.");
    assert.equal(first.status, "working");
    assert.equal(readFrontendWorkflowState(root)?.stage, "slice_planning");
    assert.equal(first.current, 0);
    assert.match(slicePrompt(plan, first, ["worktree_read", "worktree_patch"]), /Available implementation tools: worktree_read, worktree_patch/);
    assert.equal(markSliceReady(root, "slice-one", "Preview and build passed.")?.status, "awaiting_feedback");
    assert.equal(readFrontendWorkflowState(root)?.stage, "awaiting_feedback");

    const second = prepareSlice(root, "", "advance", "Looks good", "slice-two", "Implement the next approved outcome.");
    assert.equal(second.current, 1);
    assert.equal(readSliceState(root)?.feedback.at(-1), "Looks good");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("final slice becomes frontend_complete only after Core checkpoints delivery", () => {
  const root = mkdtempSync(join(tmpdir(), "borg-project-complete-"));
  try {
    const plan = fallbackProjectPlan("A static portfolio with projects and contact links.", "portfolio");
    persistProposedProjectPlan(root, "A static portfolio with projects and contact links.", plan, "plan-task");
    let state = approveProjectPlan(root, "plan-task").state;
    for (let index = 0; index < plan.slices.length; index += 1) {
      state = prepareSlice(root, "", index === 0 ? "initial" : "advance", index === 0 ? "" : "Approved", `slice-${index}`, "Mini-plan");
      const ready = markSliceReady(root, `slice-${index}`, "Typecheck, build, browser, responsive, accessibility, and visual checks passed.");
      assert.ok(ready);
      state = ready!;
    }

    assert.equal(state.status, "awaiting_feedback");
    assert.notEqual(readProjectPlan(root)?.status, "frontend_complete");
    assert.match(readProjectDocs(root).find((doc) => doc.path.endsWith("/handoff.md"))?.content ?? "", /not complete until Core checkpoints delivery/i);

    const now = new Date().toISOString();
    const deliveredPlan = { ...readProjectPlan(root)!, status: "frontend_complete" as const };
    const delivered = WorkflowStateSchema.parse({
      projectId: "site",
      taskId: `slice-${plan.slices.length - 1}`,
      loop: "slice",
      phase: "frontend",
      status: "awaiting_feedback",
      nextAction: "request_feedback",
      planApprovalId: "plan-approval",
      planApproved: true,
      projectPlan: deliveredPlan,
      sliceIndex: plan.slices.length - 1,
      sliceTotal: plan.slices.length,
      sliceTitle: plan.slices.at(-1)!.title,
      feedback: [],
      handoff: null,
      pendingCommand: null,
      lastConsumedCommandId: "final-command",
      repairAttempt: 0,
      recoveryCategory: null,
      detail: "Final frontend slice delivered.",
      version: 10,
      createdAt: now,
      updatedAt: now,
    });
    const projected = projectDeliveredFrontendCheckpoint(root, delivered);
    assert.equal(projected?.status, "frontend_complete");
    assert.equal(projected?.backendRequired, false);
    assert.equal(readProjectPlan(root)?.status, "frontend_complete");
    assert.equal(readFrontendWorkflowState(root)?.stage, "frontend_complete");
    assert.match(readProjectDocs(root).find((doc) => doc.path.endsWith("/handoff.md"))?.content ?? "", /No backend phase is required/i);
    assert.throws(() => prepareSlice(root, "", "advance", "Approved", "extra"), /Frontend is complete/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("plan coverage detects required product capabilities instead of checking pages only", () => {
  const brief = "Build an authenticated operations app. Users must sign in, search and filter jobs, create/edit/delete jobs, and view reports.";
  const plan = fallbackProjectPlan("Build an internal operations dashboard with Jobs and Reports.", "dashboard");
  const report = validateProjectPlanCoverage(plan, brief);

  assert.ok(report.requiredCapabilities.includes("authentication"));
  assert.ok(report.requiredCapabilities.includes("record_mutation"));
  assert.ok(report.requiredCapabilities.includes("search_filtering"));
  assert.ok(report.requiredCapabilities.includes("reporting"));
  assert.ok(report.missingCapabilities.includes("authentication"));
  assert.equal(report.valid, false);
});

test("plan coverage rejects marketing structure when the brief explicitly requires an internal product", () => {
  const brief = "Build an internal dispatcher application. Do not build a marketing or landing site. Required pages: Overview, Jobs, Customers, Settings.";
  const plan = fallbackProjectPlan(brief, "dashboard");
  const invalid = {
    ...plan,
    slices: [
      {
        id: "hero",
        title: "Homepage hero and CTA",
        outcome: "A polished marketing homepage introduces the product.",
        scope: ["Hero", "Testimonials", "Call to action"],
        acceptanceCriteria: ["CTA is visible"],
      },
      ...plan.slices.slice(1),
    ],
  };
  const report = validateProjectPlanCoverage(invalid, brief);

  assert.equal(report.valid, false);
  assert.ok(report.contradictions.some((item) => /marketing|landing/i.test(item)));
  assert.ok(report.issues.some((item) => /marketing|landing/i.test(item)));
});

test("persisted plans write an inspectable semantic coverage report and refuse invalid plans", () => {
  const root = mkdtempSync(join(tmpdir(), "borg-plan-coverage-"));
  try {
    const brief = "Build ForgeOps. Required pages: Overview, Jobs, Customers, Settings.";
    const validPlan = fallbackProjectPlan(brief, "dashboard");
    persistProposedProjectPlan(root, brief, validPlan, "coverage-task");

    assert.ok(existsSync(join(root, ".localcode", "build", "plan-coverage.md")));
    assert.ok(existsSync(join(root, ".localcode", "build", "plan-coverage.json")));
    assert.match(readProjectDocs(root).find((doc) => doc.path.endsWith("/plan-coverage.md"))?.content ?? "", /Status: \*\*pass\*\*/i);

    const invalidPlan = {
      ...validPlan,
      sitemap: validPlan.sitemap.filter((page) => page.name !== "Jobs"),
    };
    assert.throws(
      () => persistProposedProjectPlan(root, brief, invalidPlan, "invalid-coverage-task"),
      /Cannot persist an invalid project plan/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
