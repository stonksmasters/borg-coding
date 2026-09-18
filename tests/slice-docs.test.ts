import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approveProjectPlan,
  fallbackProjectPlan,
  markSliceReady,
  parseProjectPlan,
  persistProposedProjectPlan,
  prepareSlice,
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

  assert.ok(landing.slices.length >= 2 && landing.slices.length <= 3);
  assert.ok(content.slices.length >= 2 && content.slices.length <= 3);
  assert.ok(ecommerce.slices.length > landing.slices.length);
  assert.ok(dashboard.slices.length > landing.slices.length);
  assert.equal(landing.backendRequired, false);
  assert.equal(ecommerce.backendRequired, true);
  assert.equal(dashboard.backendRequired, true);
});

test("structured model plans replace the fixed slice list", () => {
  const answer = `Plan summary.
<borg-project-plan>{"siteGoal":"Launch a collector marketplace","audience":"Collectors","pages":["Home","Browse","Listing"],"features":["Search","Listing detail"],"visualDirection":"Editorial dark","backendRequired":true,"slices":[{"id":"shell","title":"Shell","outcome":"Navigable shell","scope":["navigation"],"acceptanceCriteria":["mobile works"]},{"id":"browse","title":"Browse","outcome":"Browse works","scope":["catalog"],"acceptanceCriteria":["filters work"]},{"id":"review","title":"Review","outcome":"Frontend gate passes","scope":["browser review"],"acceptanceCriteria":["build passes"]}],"acceptanceCriteria":["all pages navigable"]}</borg-project-plan>`;
  const plan = parseProjectPlan(answer, "Build a marketplace", "ecommerce");
  assert.equal(plan.slices.length, 3);
  assert.equal(plan.slices[1].title, "Browse");
  assert.equal(plan.backendRequired, true);
  assert.equal(plan.siteGoal, "Launch a collector marketplace");
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

    const plan = readProjectPlan(root)!;
    const planPrompt = slicePlanningPrompt(plan, approved.state);
    assert.match(planPrompt, /MINI LOOP/);
    assert.match(planPrompt, /Do not rediscover the whole repository/i);
    assert.match(planPrompt, /request escalation to EDIT/i);
    assert.doesNotMatch(planPrompt, /new project-planning pass/i);

    const first = prepareSlice(root, "", "initial", "", "slice-one", "Patch the shell only.");
    assert.equal(first.status, "working");
    assert.equal(first.current, 0);
    assert.match(slicePrompt(plan, first, ["worktree_read", "worktree_patch"]), /Available implementation tools: worktree_read, worktree_patch/);
    assert.equal(markSliceReady(root, "slice-one", "Preview and build passed.")?.status, "awaiting_feedback");

    const second = prepareSlice(root, "", "advance", "Looks good", "slice-two", "Implement the next approved outcome.");
    assert.equal(second.current, 1);
    assert.equal(readSliceState(root)?.feedback.at(-1), "Looks good");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("final slice reaches frontend_complete without inventing backend work", () => {
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
    assert.equal(state.status, "frontend_complete");
    assert.equal(state.backendRequired, false);
    assert.match(readProjectDocs(root).find((doc) => doc.path.endsWith("/handoff.md"))?.content ?? "", /No backend phase is required/i);
    assert.throws(() => prepareSlice(root, "", "advance", "Approved", "extra"), /Frontend is complete/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
