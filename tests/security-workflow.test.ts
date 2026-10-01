import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApproval, createTask } from "../packages/core/src/contracts.ts";
import { WorkflowEngine } from "../packages/core/src/workflow-engine.ts";
import { SqliteTaskRepository } from "../packages/persistence/src/sqlite-task-repository.ts";
import { SecurityService } from "../apps/server/src/security-service.ts";

function reachSecurityPlanning(engine: WorkflowEngine, taskInput: ReturnType<typeof createTask>, assessmentId: string) {
  let task = taskInput;
  let state = engine.startSecurityAssessment(task, assessmentId);
  let changed = engine.transition(task, "CLASSIFYING");
  task = changed.task;
  state = changed.workflow;
  changed = engine.transition(task, "DISCOVERING");
  task = changed.task;
  state = changed.workflow;
  changed = engine.transition(task, "PLANNING");
  return { task: changed.task, workflow: changed.workflow };
}

test("security workflow authority survives SQLite restart with assessment context", () => {
  const root = mkdtempSync(join(tmpdir(), "borg-security-workflow-"));
  const databasePath = join(root, "borg.db");
  let tasks = new SqliteTaskRepository(databasePath);
  try {
    let engine = new WorkflowEngine(tasks);
    const task = createTask({
      id: "security-task",
      projectId: "security-project",
      request: "Assess the authorized lab",
      riskLevel: "R2",
    });
    const planned = reachSecurityPlanning(engine, task, "assessment-1");

    assert.equal(planned.task.state, "PLANNING");
    assert.equal(planned.workflow.loop, "security");
    assert.equal(planned.workflow.security?.assessmentId, "assessment-1");
    assert.equal(planned.workflow.security?.operationId, null);
    assert.equal(planned.workflow.security?.executionId, null);
    tasks.close();

    tasks = new SqliteTaskRepository(databasePath);
    engine = new WorkflowEngine(tasks);
    const restored = engine.get(task.projectId);
    assert.equal(restored?.loop, "security");
    assert.equal(restored?.taskId, task.id);
    assert.equal(restored?.security?.assessmentId, "assessment-1");
    assert.equal(restored?.status, "planning");
  } finally {
    tasks.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("planned security operation is bound to workflow and waits at the existing approval gate", () => {
  const root = mkdtempSync(join(tmpdir(), "borg-security-approval-"));
  const databasePath = join(root, "borg.db");
  const tasks = new SqliteTaskRepository(databasePath);
  const security = new SecurityService(databasePath);
  try {
    security.registerNode({
      id: "kali-pi",
      name: "Kali Pi",
      provider: "ssh",
      host: "192.168.4.42",
      username: "borg",
    });
    const created = security.createAssessment({
      id: "assessment-approval",
      projectId: "security-approval-project",
      name: "Authorized lab",
      mode: "active_recon",
      executionNodeId: "kali-pi",
      scope: {
        allowedCidrs: ["192.168.4.0/24"],
        authorizationConfirmed: true,
      },
    });

    const engine = new WorkflowEngine(tasks);
    const taskInput = createTask({
      id: "security-approval-task",
      projectId: created.assessment.projectId,
      request: "Inventory one authorized host",
      riskLevel: "R2",
    });
    let { task, workflow } = reachSecurityPlanning(engine, taskInput, created.assessment.id);

    const planned = security.planExecution({
      id: "execution-1",
      operationId: "operation-1",
      assessmentId: created.assessment.id,
      taskId: task.id,
      workflowVersion: workflow.version + 1,
      operation: "service_inventory",
      classification: "active_recon",
      targets: [{ kind: "host", value: "192.168.4.42" }],
    });
    workflow = engine.bindSecurityOperation(task, planned.execution.operationId, planned.execution.id);
    assert.equal(workflow.security?.executionId, "execution-1");

    const approval = createApproval({ id: "security-approval", taskId: task.id });
    const awaiting = engine.requestApproval(task, approval, "execution");
    task = awaiting.task;
    workflow = awaiting.workflow;

    assert.equal(task.state, "AWAITING_APPROVAL");
    assert.equal(workflow.status, "awaiting_approval");
    assert.equal(workflow.security?.operationId, "operation-1");
    assert.equal(security.getExecution("execution-1")?.status, "planned");
    assert.equal(security.getExecution("execution-1")?.toolRequest?.toolId, "nmap");
    assert.equal(security.getExecution("execution-1")?.toolRequest?.risk, "active");
    assert.equal(security.getExecution("execution-1")?.toolRequest?.approvalRequirement, "execution");

    const approved = { ...approval, status: "APPROVED" as const, decidedAt: new Date().toISOString() };
    const decided = engine.decideApproval(task, approved, "execution");
    security.setExecutionStatus("execution-1", "approved");

    assert.equal(decided.task.state, "IMPLEMENTING");
    assert.equal(decided.workflow.loop, "security");
    assert.equal(decided.workflow.security?.executionId, "execution-1");
    assert.equal(decided.workflow.nextAction, "implement");
    assert.equal(security.getExecution("execution-1")?.status, "approved");
  } finally {
    security.close();
    tasks.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("security operation planning fails closed for an out-of-scope target", () => {
  const security = new SecurityService(":memory:");
  try {
    security.registerNode({
      id: "kali-pi",
      name: "Kali Pi",
      provider: "ssh",
      host: "192.168.4.42",
      username: "borg",
    });
    security.createAssessment({
      id: "assessment-scope",
      projectId: "security-scope-project",
      name: "Authorized lab",
      mode: "active_recon",
      executionNodeId: "kali-pi",
      scope: {
        allowedCidrs: ["192.168.4.0/24"],
        authorizationConfirmed: true,
      },
    });

    assert.throws(() => security.planExecution({
      assessmentId: "assessment-scope",
      taskId: "task-scope",
      workflowVersion: 1,
      operation: "service_inventory",
      classification: "active_recon",
      targets: [{ kind: "host", value: "8.8.8.8" }],
    }), /outside the authorized assessment scope/i);

    assert.deepEqual(security.listExecutions("assessment-scope"), []);
  } finally {
    security.close();
  }
});

test("security evidence preserves hash, provenance and restart durability", () => {
  const root = mkdtempSync(join(tmpdir(), "borg-security-evidence-"));
  const databasePath = join(root, "borg.db");
  let security = new SecurityService(databasePath);
  try {
    security.registerNode({
      id: "kali-pi",
      name: "Kali Pi",
      provider: "ssh",
      host: "192.168.4.42",
      username: "borg",
    });
    security.createAssessment({
      id: "assessment-evidence",
      projectId: "security-evidence-project",
      name: "Evidence test",
      mode: "passive_recon",
      executionNodeId: "kali-pi",
      scope: {
        allowedDomains: ["example.com"],
      },
    });
    security.planExecution({
      id: "execution-evidence",
      operationId: "operation-evidence",
      assessmentId: "assessment-evidence",
      taskId: "task-evidence",
      workflowVersion: 2,
      operation: "dns_lookup",
      classification: "passive",
      targets: [{ kind: "domain", value: "example.com" }],
    });
    const evidence = security.recordEvidence({
      id: "evidence-1",
      executionId: "execution-evidence",
      kind: "stdout",
      text: "example.com. 300 IN A 192.0.2.10\n",
    });

    assert.equal(evidence.byteLength, 33);
    assert.match(evidence.sha256, /^[a-f0-9]{64}$/);
    assert.equal(evidence.assessmentId, "assessment-evidence");
    assert.equal(evidence.taskId, "task-evidence");
    security.close();

    security = new SecurityService(databasePath);
    const restored = security.listEvidence("execution-evidence");
    assert.equal(restored.length, 1);
    assert.equal(restored[0]?.id, "evidence-1");
    assert.equal(restored[0]?.inlineText, "example.com. 300 IN A 192.0.2.10\n");
    assert.equal(restored[0]?.sha256, evidence.sha256);
  } finally {
    security.close();
    rmSync(root, { recursive: true, force: true });
  }
});
