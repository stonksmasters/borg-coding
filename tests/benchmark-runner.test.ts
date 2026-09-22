import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import { parseFrontendAutonomyBenchmark } from "../packages/benchmark/src/contracts.ts";
import { BorgBenchmarkClient } from "../packages/benchmark/src/borg-client.ts";
import { runFrontendBenchmark } from "../packages/benchmark/src/runner.ts";

async function readJson(request: IncomingMessage) {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return body.trim() ? JSON.parse(body) as Record<string, unknown> : {};
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function ndjson(response: ServerResponse, events: Record<string, unknown>[]) {
  response.writeHead(200, { "content-type": "application/x-ndjson" });
  response.end(events.map((event) => JSON.stringify(event)).join("\n") + "\n");
}

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fake gateway did not expose a TCP port.");
  return address.port;
}

const benchmark = parseFrontendAutonomyBenchmark({
  version: 1,
  id: "runner-test",
  name: "Runner integration",
  kind: "frontend-autonomy",
  promptPath: "prompt.md",
  expected: {
    frontendOnly: true,
    requiredRoutes: ["/", "/work"],
    minimumPages: 2,
    requireBrowserVerification: true,
    requireResponsiveVerification: true,
    requireAccessibilityVerification: true,
    requireFrontendComplete: true,
  },
  limits: {
    maxProjectPlanRevisions: 1,
    maxRepairAttemptsPerSlice: 3,
    maxContextCharacters: 24_000,
  },
});

test("runner follows gateway authority from planning approval through two autonomous slices", async () => {
  let task = "plan-task";
  let approvalRequested = true;
  let planApprovals = 0;
  let continueCalls = 0;
  let sliceOneStatusReads = 0;

  const gateway = createServer((request, response) => {
    void (async () => {
      const url = request.url ?? "/";
      if (request.method === "GET" && url === "/health") {
        return json(response, 200, { status: "ok", gateway: true, core: { runtimeConnected: true, modelAvailable: true, model: "fake" } });
      }
      if (request.method === "POST" && url === "/api/websites") {
        const body = await readJson(request);
        assert.match(String(body.brief ?? ""), /Northline/);
        return json(response, 201, { session: { id: "session-1", title: "Benchmark", activeMode: "plan", workspaceId: "runner-test", workflowRole: "primary" } });
      }
      if (request.method === "POST" && url === "/api/chat") {
        const body = await readJson(request);
        assert.equal(body.sessionId, "session-1");
        return ndjson(response, [
          { type: "task.created", task: { id: "plan-task", state: "PLANNING" } },
          { type: "project.plan.approval.requested", taskId: "plan-task" },
          { type: "stream.completed", taskId: "plan-task" },
        ]);
      }
      if (request.method === "GET" && url === "/api/sessions/session-1") {
        return json(response, 200, {
          session: { id: "session-1", activeMode: approvalRequested ? "plan" : "edit", workflowRole: "primary" },
          latestTaskId: task,
          task: { id: task, state: approvalRequested ? "AWAITING_APPROVAL" : task === "slice-2" ? "COMPLETE" : "IMPLEMENTING" },
          approval: approvalRequested ? { id: "plan-approval", taskId: "plan-task", status: "REQUESTED" } : null,
          projectPlanApproval: approvalRequested,
          projectPlanRevisionApproval: false,
          runtimeAvailable: true,
          runtimeActive: !approvalRequested && task === "slice-1",
        });
      }
      if (request.method === "POST" && url === "/api/tasks/plan-task/approval") {
        const body = await readJson(request);
        assert.equal(body.decision, "approve");
        planApprovals += 1;
        approvalRequested = false;
        task = "slice-1";
        return json(response, 200, { projectPlanApproved: true, workflowStarted: true });
      }
      if (request.method === "GET" && url === "/api/tasks/slice-1/workflow-status") {
        sliceOneStatusReads += 1;
        if (sliceOneStatusReads >= 1) task = "slice-2";
        return json(response, 200, {
          taskId: "slice-1",
          taskState: "COMPLETE",
          source: "sqlite",
          phase: "frontend",
          status: "working",
          sliceIndex: 0,
          sliceTotal: 2,
          sliceTitle: "Home",
          verificationPassed: true,
          repairAttempt: 0,
          nextAction: "advance_slice",
          run: { stage: "ready", headline: "Home is verified", nextAction: "advance_slice", blocker: null, verification: { status: "passed" } },
        });
      }
      if (request.method === "GET" && url === "/api/control/tasks/slice-1/snapshot") {
        return json(response, 200, {
          snapshot: {
            version: 1,
            generatedAt: new Date().toISOString(),
            readOnly: true,
            task: { id: "slice-1", state: "COMPLETE", attempts: 0 },
            workflow: {
              version: 4, phase: "frontend", status: "running", sliceIndex: 0, sliceTotal: 2, sliceTitle: "Home",
              nextAction: "advance_slice", repairAttempt: 0, attemptPhase: "implementation",
              verification: { status: "passed", attempt: 0 },
              projectPlan: { backendRequired: false, sitemap: [{ route: "/" }, { route: "/work" }] },
            },
            approval: { status: "APPROVED", worktreePath: "/tmp/slice-1", baseCommit: "base" },
            events: [],
            contextPacks: [{ id: "pack-1", sliceId: "home", characters: 10000, budgetCharacters: 24000 }],
            git: { worktreePath: "/tmp/slice-1", worktreeExists: true, baseCommit: "base", headCommit: "head" },
            checkpoints: [{ id: "cp-1", kind: "pre_delivery", taskState: "DELIVERY_READY", workflowVersion: 4, verification: { status: "passed" } }],
            diagnostics: [],
          },
        });
      }
      if (request.method === "GET" && url === "/api/tasks/slice-2/workflow-status") {
        return json(response, 200, {
          taskId: "slice-2",
          taskState: "COMPLETE",
          source: "sqlite",
          phase: "frontend",
          status: "awaiting_feedback",
          sliceIndex: 1,
          sliceTotal: 2,
          sliceTitle: "Work",
          verificationPassed: true,
          repairAttempt: 0,
          nextAction: "request_feedback",
          run: { stage: "ready", headline: "Frontend complete", nextAction: "request_feedback", blocker: null, verification: { status: "passed" } },
        });
      }
      if (request.method === "GET" && url === "/api/control/tasks/slice-2/snapshot") {
        return json(response, 200, {
          snapshot: {
            version: 1,
            generatedAt: new Date().toISOString(),
            readOnly: true,
            task: { id: "slice-2", state: "COMPLETE", attempts: 0 },
            workflow: {
              version: 5, phase: "frontend", status: "awaiting_feedback", sliceIndex: 1, sliceTotal: 2, sliceTitle: "Work",
              nextAction: "request_feedback", repairAttempt: 0, attemptPhase: "implementation",
              verification: { status: "passed", attempt: 0 },
              projectPlan: { backendRequired: false, sitemap: [{ route: "/" }, { route: "/work" }] },
            },
            approval: { status: "APPROVED", worktreePath: "/tmp/slice-2", baseCommit: "base" },
            events: [],
            contextPacks: [{ id: "pack-2", sliceId: "work", characters: 11000, budgetCharacters: 24000 }],
            git: { worktreePath: "/tmp/slice-2", worktreeExists: true, baseCommit: "base", headCommit: "head" },
            checkpoints: [{ id: "cp-2", kind: "pre_delivery", taskState: "DELIVERY_READY", workflowVersion: 5, verification: { status: "passed" } }],
            diagnostics: [],
          },
        });
      }
      if (request.method === "POST" && url === "/api/frontend-workflow/continue") {
        continueCalls += 1;
        return json(response, 500, { error: "The benchmark runner must not drive slices manually." });
      }
      return json(response, 404, { error: `Unhandled fake-gateway route ${request.method} ${url}` });
    })().catch((error) => json(response, 500, { error: error instanceof Error ? error.message : String(error) }));
  });

  try {
    const port = await listen(gateway);
    const outcome = await runFrontendBenchmark({
      client: new BorgBenchmarkClient(`http://127.0.0.1:${port}`),
      benchmark,
      prompt: "Build Northline.",
      websiteName: "Northline benchmark",
      timeoutMs: 2_000,
      pollIntervalMs: 0,
      sleep: async () => {},
    });

    assert.equal(outcome.result.status, "PASS");
    assert.equal(outcome.result.failures.length, 0);
    assert.equal(planApprovals, 1);
    assert.equal(outcome.approvals.projectPlan, 1);
    assert.equal(outcome.approvals.projectPlanRevision, 0);
    assert.deepEqual(outcome.taskIds, ["plan-task", "slice-1", "slice-2"]);
    assert.equal(outcome.snapshots.length, 2);
    assert.equal(continueCalls, 0, "runner must not call the manual frontend continuation endpoint");
    assert.ok(outcome.observations.some((item) => item.sliceTitle === "Home" && item.nextAction === "advance_slice"));
    assert.ok(outcome.observations.some((item) => item.sliceTitle === "Work" && item.nextAction === "request_feedback"));
  } finally {
    await new Promise<void>((resolveClose) => gateway.close(() => resolveClose()));
  }
});

test("runner refuses an implementation approval gate it does not own", async () => {
  let unexpectedApprovalCalls = 0;
  const gateway = createServer((request, response) => {
    const url = request.url ?? "/";
    if (request.method === "GET" && url === "/health") {
      return json(response, 200, { core: { runtimeConnected: true, modelAvailable: true } });
    }
    if (request.method === "POST" && url === "/api/websites") {
      return json(response, 201, { session: { id: "session-2", workflowRole: "primary" } });
    }
    if (request.method === "POST" && url === "/api/chat") {
      return ndjson(response, [{ type: "task.created", task: { id: "task-2" } }, { type: "stream.completed", taskId: "task-2" }]);
    }
    if (request.method === "GET" && url === "/api/sessions/session-2") {
      return json(response, 200, {
        session: { id: "session-2", workflowRole: "primary" },
        latestTaskId: "task-2",
        task: { id: "task-2", state: "AWAITING_APPROVAL" },
        approval: { id: "implementation-approval", taskId: "task-2", status: "REQUESTED" },
        projectPlanApproval: false,
        projectPlanRevisionApproval: false,
        runtimeAvailable: true,
        runtimeActive: false,
      });
    }
    if (request.method === "POST" && url === "/api/tasks/task-2/approval") {
      unexpectedApprovalCalls += 1;
      return json(response, 200, {});
    }
    if (request.method === "GET" && url === "/api/tasks/task-2/workflow-status") {
      return json(response, 200, {
        taskId: "task-2",
        taskState: "AWAITING_APPROVAL",
        phase: "frontend",
        status: "working",
        sliceIndex: 0,
        sliceTotal: 2,
        sliceTitle: "Home",
        verificationPassed: null,
        repairAttempt: 0,
        nextAction: "approve",
        run: { stage: "awaiting_approval", headline: "Approval required", nextAction: "approve", blocker: null, verification: { status: "pending" } },
      });
    }
    return json(response, 404, {});
  });

  try {
    const port = await listen(gateway);
    const outcome = await runFrontendBenchmark({
      client: new BorgBenchmarkClient(`http://127.0.0.1:${port}`),
      benchmark,
      prompt: "Build Northline.",
      timeoutMs: 500,
      pollIntervalMs: 0,
      sleep: async () => {},
    });
    assert.equal(outcome.result.status, "BLOCKED");
    assert.equal(outcome.result.failures[0]?.code, "UNSUPPORTED_OPERATOR_GATE");
    assert.equal(unexpectedApprovalCalls, 0);
  } finally {
    await new Promise<void>((resolveClose) => gateway.close(() => resolveClose()));
  }
});
