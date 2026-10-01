import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SecurityService } from "../apps/server/src/security-service.ts";

const host = process.env.BORG_KALI_HOST?.trim();
const username = process.env.BORG_KALI_USER?.trim() || "kali";
const port = Number(process.env.BORG_KALI_PORT || "22");
const domain = process.env.BORG_KALI_TEST_DOMAIN?.trim() || "example.com";
const activeTarget = process.env.BORG_KALI_TEST_HOST?.trim() || host;

if (!host) throw new Error("BORG_KALI_HOST is required for the opt-in Kali integration test.");
if (!activeTarget) throw new Error("BORG_KALI_TEST_HOST or BORG_KALI_HOST is required for active-recon scope.");

test("live Kali node executes typed DNS and bounded service inventory operations", async () => {
  const root = mkdtempSync(join(tmpdir(), "borg-kali-live-"));
  const databasePath = join(root, "borg.db");
  let service = new SecurityService(databasePath);
  try {
    service.registerNode({
      id: "kali-live",
      name: "Kali Raspberry Pi",
      provider: "ssh",
      securityRuntime: "kali_mcp",
      host,
      port,
      username,
    });
    const node = await service.refreshNode("kali-live");
    assert.equal(node.status, "online", node.lastError ?? undefined);
    assert.equal(node.securityRuntime, "kali_mcp");
    assert.ok(node.mcpTools.length > 0);
    assert.equal(node.platform, "Linux");
    assert.equal(node.capabilities.find((value) => value.id === "dig")?.status, "available");
    assert.equal(node.capabilities.find((value) => value.id === "nmap")?.status, "available");

    service.createAssessment({
      id: "live-dns-assessment",
      projectId: "live-kali-project",
      name: "Live DNS validation",
      mode: "passive_recon",
      executionNodeId: node.id,
      scope: { allowedDomains: [domain] },
    });
    service.planExecution({
      id: "live-dns-execution",
      assessmentId: "live-dns-assessment",
      taskId: "live-dns-task",
      workflowVersion: 1,
      operation: "dns_lookup",
      classification: "passive",
      targets: [{ kind: "domain", value: domain }],
    });
    service.setExecutionStatus("live-dns-execution", "approved");
    const dns = await service.executeApprovedOperation("live-dns-execution");
    assert.equal(dns.execution.status, "succeeded");
    assert.ok((dns.normalized as { records: unknown[] }).records.length > 0);
    assert.deepEqual(dns.evidence.map((value) => value.kind), ["stdout", "stderr", "normalized"]);
    assert.ok(service.listAssets("live-dns-assessment").some((value) => value.kind === "domain" && value.key === domain));
    assert.ok(service.listObservations("live-dns-assessment").length > 0);
    assert.ok(service.listRelationships("live-dns-assessment").length > 0);

    service.createAssessment({
      id: "live-service-assessment",
      projectId: "live-kali-project",
      name: "Live bounded service validation",
      mode: "active_recon",
      executionNodeId: node.id,
      scope: { allowedHosts: [activeTarget], authorizationConfirmed: true },
    });
    service.planExecution({
      id: "live-service-execution",
      assessmentId: "live-service-assessment",
      taskId: "live-service-task",
      workflowVersion: 1,
      operation: "service_inventory",
      classification: "active_recon",
      targets: [{ kind: "host", value: activeTarget }],
    });
    service.setExecutionStatus("live-service-execution", "approved");
    const inventory = await service.executeApprovedOperation("live-service-execution");
    assert.equal(inventory.execution.status, "succeeded", inventory.execution.error ?? undefined);
    assert.ok(Array.isArray((inventory.normalized as { services: unknown[] }).services));
    assert.deepEqual(inventory.evidence.map((value) => value.kind), ["stdout", "stderr", "normalized"]);
    assert.ok(service.listAssets("live-service-assessment").some((value) => value.kind === "host" && value.key === activeTarget));
    assert.ok(service.listServices("live-service-assessment").length > 0);

    service.close();
    service = new SecurityService(databasePath);
    assert.equal(service.getExecution("live-dns-execution")?.status, "succeeded");
    assert.equal(service.getExecution("live-service-execution")?.status, "succeeded");
    assert.equal(service.listEvidence("live-dns-execution").length, 3);
    assert.equal(service.listEvidence("live-service-execution").length, 3);
    assert.ok(service.listAssets("live-dns-assessment").length > 1);
    assert.ok(service.listServices("live-service-assessment").length > 0);
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
