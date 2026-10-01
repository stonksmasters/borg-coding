import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SecurityService } from "../apps/server/src/security-service.ts";

test("investigation planner creates ordered executable and blocked steps", () => {
  const service = new SecurityService(":memory:");
  try {
    service.registerNode({ id: "kali", name: "Kali", provider: "ssh", host: "kali.local", username: "borg" });
    service.createAssessment({ id: "assessment", projectId: "project", name: "Investigation", mode: "authorized_assessment", executionNodeId: "kali", scope: { allowedDomains: ["example.com"], allowedHosts: ["192.168.4.20"], allowedEmails: ["owner@example.com"], authorizationConfirmed: true } });
    const plan = service.createInvestigationPlan("assessment", {
      objective: "Map the authorized public and network footprint.",
      subjects: [
        { kind: "domain", value: "example.com" },
        { kind: "host", value: "192.168.4.20" },
        { kind: "email", value: "owner@example.com" },
      ],
    });
    assert.equal(plan.status, "ready");
    assert.deepEqual(plan.steps.map((step) => step.sequence), [1, 2, 3, 4, 5]);
    assert.deepEqual(plan.steps.map((step) => step.status), ["proposed", "proposed", "proposed", "proposed", "proposed"]);
    assert.equal(plan.steps[0]?.toolRequest?.toolId, "dig");
    assert.equal(plan.steps[1]?.toolRequest?.toolId, "dnsrecon");
    assert.equal(plan.steps[2]?.toolRequest?.toolId, "nmap");
    assert.equal(plan.steps[3]?.toolRequest?.toolId, "theharvester");
    assert.equal(plan.steps[4]?.toolRequest?.toolId, "holehe");
    assert.deepEqual(service.listExecutions("assessment"), []);
  } finally { service.close(); }
});

test("investigation plans survive SQLite restart", () => {
  const root = mkdtempSync(join(tmpdir(), "borg-investigation-plan-"));
  const databasePath = join(root, "borg.db");
  let service = new SecurityService(databasePath);
  try {
    service.registerNode({ id: "kali", name: "Kali", provider: "ssh", host: "kali.local", username: "borg" });
    service.createAssessment({ id: "assessment", projectId: "project", name: "Investigation", mode: "osint", executionNodeId: "kali", scope: { allowedDomains: ["example.com"] } });
    const created = service.createInvestigationPlan("assessment", { objective: "Resolve the public domain.", subjects: [{ kind: "domain", value: "example.com" }] });
    service.close();
    service = new SecurityService(databasePath);
    assert.deepEqual(service.getInvestigationPlan(created.id), created);
    assert.deepEqual(service.listInvestigationPlans("assessment"), [created]);
  } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
});

test("investigation planner preserves policy failures as blocked steps", () => {
  const service = new SecurityService(":memory:");
  try {
    service.registerNode({ id: "kali", name: "Kali", provider: "ssh", host: "kali.local", username: "borg" });
    service.createAssessment({ id: "assessment", projectId: "project", name: "Investigation", mode: "passive_recon", executionNodeId: "kali", scope: { allowedDomains: ["example.com"] } });
    const plan = service.createInvestigationPlan("assessment", { objective: "Check a host.", subjects: [{ kind: "host", value: "8.8.8.8" }] });
    assert.equal(plan.status, "blocked");
    assert.equal(plan.steps[0]?.status, "blocked");
    assert.match(plan.steps[0]?.reason ?? "", /does not permit|outside/i);
  } finally { service.close(); }
});
