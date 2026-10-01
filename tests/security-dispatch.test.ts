import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SecurityService } from "../apps/server/src/security-service.ts";
import type { ExecutionNode } from "../packages/core/src/security-domain.ts";
import type { ExecutionProvider, ExecutionRequest, ExecutionResult, NodeHealth } from "../packages/core/src/execution-provider.ts";

class DispatchProvider implements ExecutionProvider {
  readonly kind = "ssh" as const;
  requests: ExecutionRequest[] = [];
  resultMode: "success" | "exit_failure" | "parser_failure" = "success";

  async healthCheck(): Promise<NodeHealth> {
    return { online: true, platform: "Linux", architecture: "aarch64", latencyMs: 2 };
  }

  async execute(node: ExecutionNode, request: ExecutionRequest): Promise<ExecutionResult> {
    this.requests.push(request);
    const now = new Date().toISOString();
    let exitCode = 0;
    let stdout = "";
    let stderr = "";
    if (request.executable === "which") {
      const capability = request.args[0];
      exitCode = capability === "dig" || capability === "nmap" ? 0 : 1;
      stdout = exitCode === 0 ? `/usr/bin/${capability}\n` : "";
    } else if (request.args.includes("--version") || request.args.includes("-v")) {
      stdout = `${request.executable} test version\n`;
    } else if (this.resultMode === "exit_failure") {
      exitCode = 2;
      stdout = "partial output\n";
      stderr = "tool failed\n";
    } else if (this.resultMode === "parser_failure") {
      stdout = "unparseable output\n";
    } else if (request.executable === "dig") {
      stdout = "example.com. 300 IN A 192.0.2.10\nexample.com. 300 IN AAAA 2001:db8::10\n";
    } else if (request.executable === "nmap") {
      stdout = `<?xml version="1.0"?><nmaprun><host><ports><port protocol="tcp" portid="22"><state state="open"/><service name="ssh" product="OpenSSH" version="9.2"/></port></ports></host></nmaprun>`;
    }
    return {
      requestId: request.id, nodeId: node.id, startedAt: now, finishedAt: now,
      exitCode, signal: null, timedOut: false, cancelled: false, stdout, stderr,
      stdoutTruncated: false, stderrTruncated: false,
    };
  }
}

async function configuredService(databasePath: string, provider: DispatchProvider, mode: "passive_recon" | "active_recon") {
  const service = new SecurityService(databasePath, provider);
  service.registerNode({ id: "kali-pi", name: "Kali Pi", provider: "ssh", host: "kali.local", username: "borg" });
  await service.refreshNode("kali-pi");
  service.createAssessment({
    id: "assessment", projectId: "project", name: "Assessment", mode, executionNodeId: "kali-pi",
    scope: mode === "passive_recon"
      ? { allowedDomains: ["example.com"] }
      : { allowedHosts: ["192.0.2.10"], authorizationConfirmed: true },
  });
  return service;
}

test("approved DNS lookup dispatches a fixed command and persists normalized evidence across restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "borg-security-dispatch-"));
  const databasePath = join(root, "borg.db");
  const provider = new DispatchProvider();
  let service = await configuredService(databasePath, provider, "passive_recon");
  try {
    service.planExecution({ id: "dns-execution", assessmentId: "assessment", taskId: "task", workflowVersion: 1, operation: "dns_lookup", classification: "passive", targets: [{ kind: "domain", value: "example.com" }] });
    service.setExecutionStatus("dns-execution", "approved");
    const result = await service.executeApprovedOperation("dns-execution");

    assert.equal(result.execution.status, "succeeded");
    assert.ok(result.execution.startedAt);
    assert.ok(result.execution.completedAt);
    const request = provider.requests.findLast((value) => value.executable === "dig");
    assert.deepEqual(request?.args, ["example.com", "+noall", "+answer", "+comments"]);
    assert.equal(result.evidence.filter((value) => value.kind === "stdout").length, 1);
    assert.equal(result.evidence.filter((value) => value.kind === "stderr").length, 1);
    assert.equal(result.evidence.filter((value) => value.kind === "normalized").length, 1);
    assert.equal((result.normalized as { records: unknown[] }).records.length, 2);
    const assets = service.listAssets("assessment");
    assert.equal(assets.filter((value) => value.kind === "domain").length, 1);
    assert.equal(assets.filter((value) => value.kind === "ip_address").length, 2);
    assert.equal(service.listObservations("assessment").length, 2);
    assert.equal(service.listRelationships("assessment").length, 2);
    const normalizedEvidence = result.evidence.find((value) => value.kind === "normalized");
    assert.ok(normalizedEvidence);
    assert.ok(service.listObservations("assessment").every((value) => value.evidenceId === normalizedEvidence.id));
    assert.ok(service.listRelationships("assessment").every((value) => value.lastEvidenceId === normalizedEvidence.id));
    service.close();

    service = new SecurityService(databasePath, provider);
    assert.equal(service.getExecution("dns-execution")?.status, "succeeded");
    assert.equal(service.listEvidence("dns-execution").length, 3);
    assert.equal(service.listAssets("assessment").length, 3);
    assert.equal(service.listObservations("assessment").length, 2);
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("bounded service inventory uses the typed nmap adapter", async () => {
  const provider = new DispatchProvider();
  const service = await configuredService(":memory:", provider, "active_recon");
  try {
    service.planExecution({ id: "nmap-execution", assessmentId: "assessment", taskId: "task", workflowVersion: 1, operation: "service_inventory", classification: "active_recon", targets: [{ kind: "host", value: "192.0.2.10" }] });
    service.setExecutionStatus("nmap-execution", "approved");
    const result = await service.executeApprovedOperation("nmap-execution");
    const request = provider.requests.findLast((value) => value.executable === "nmap");

    assert.equal(result.execution.status, "succeeded");
    assert.deepEqual(request?.args, ["-Pn", "-sT", "-sV", "--version-light", "--top-ports", "100", "-oX", "-", "--", "192.0.2.10"]);
    assert.deepEqual((result.normalized as { services: unknown[] }).services, [{ port: 22, protocol: "tcp", state: "open", service: "ssh", product: "OpenSSH", version: "9.2" }]);
    const [host] = service.listAssets("assessment");
    const [savedService] = service.listServices("assessment");
    const [observation] = service.listObservations("assessment");
    const normalizedEvidence = result.evidence.find((value) => value.kind === "normalized");
    assert.equal(host?.kind, "host");
    assert.equal(host?.key, "192.0.2.10");
    assert.equal(savedService?.port, 22);
    assert.equal(savedService?.product, "OpenSSH");
    assert.equal(savedService?.lastEvidenceId, normalizedEvidence?.id);
    assert.equal(observation?.serviceId, savedService?.id);
    assert.equal(observation?.evidenceId, normalizedEvidence?.id);
  } finally {
    service.close();
  }
});

test("repeated recon deduplicates assets and services while retaining observation history", async () => {
  const provider = new DispatchProvider();
  const service = await configuredService(":memory:", provider, "passive_recon");
  try {
    for (const suffix of ["one", "two"]) {
      service.planExecution({ id: `dns-${suffix}`, operationId: `operation-${suffix}`, assessmentId: "assessment", taskId: "task", workflowVersion: 1, operation: "dns_lookup", classification: "passive", targets: [{ kind: "domain", value: "example.com" }] });
      service.setExecutionStatus(`dns-${suffix}`, "approved");
      await service.executeApprovedOperation(`dns-${suffix}`);
    }
    assert.equal(service.listAssets("assessment").length, 3);
    assert.equal(service.listRelationships("assessment").length, 2);
    assert.equal(service.listObservations("assessment").length, 4);
    assert.equal(new Set(service.listObservations("assessment").map((value) => value.executionId)).size, 2);
  } finally {
    service.close();
  }
});

test("failed tools and parser failures retain raw stdout and stderr evidence", async () => {
  for (const mode of ["exit_failure", "parser_failure"] as const) {
    const provider = new DispatchProvider();
    provider.resultMode = mode;
    const service = await configuredService(":memory:", provider, "passive_recon");
    try {
      service.planExecution({ id: `execution-${mode}`, assessmentId: "assessment", taskId: "task", workflowVersion: 1, operation: "dns_lookup", classification: "passive", targets: [{ kind: "domain", value: "example.com" }] });
      service.setExecutionStatus(`execution-${mode}`, "approved");
      if (mode === "parser_failure") {
        await assert.rejects(service.executeApprovedOperation(`execution-${mode}`), /no parseable/i);
      } else {
        const result = await service.executeApprovedOperation(`execution-${mode}`);
        assert.equal(result.execution.status, "failed");
      }
      assert.equal(service.getExecution(`execution-${mode}`)?.status, "failed");
      assert.deepEqual(service.listEvidence(`execution-${mode}`).map((value) => value.kind), ["stdout", "stderr"]);
    } finally {
      service.close();
    }
  }
});

test("planning fails closed when a registry tool has no typed adapter", async () => {
  const provider = new DispatchProvider();
  const service = await configuredService(":memory:", provider, "passive_recon");
  try {
    assert.throws(() => service.planExecution({ id: "unknown-adapter", assessmentId: "assessment", taskId: "task", workflowVersion: 1, operation: "whois_lookup", classification: "passive", targets: [{ kind: "domain", value: "example.com" }] }), /no typed execution adapter/i);
    assert.equal(service.getExecution("unknown-adapter"), null);
    assert.equal(provider.requests.some((value) => value.executable === "whois"), false);
  } finally {
    service.close();
  }
});
