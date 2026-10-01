import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionNode } from "../packages/core/src/security-domain.ts";
import type {
  ExecutionOptions,
  ExecutionProvider,
  ExecutionRequest,
  ExecutionResult,
  NodeHealth,
} from "../packages/core/src/execution-provider.ts";
import { SecurityService } from "../apps/server/src/security-service.ts";

class ServiceFakeProvider implements ExecutionProvider {
  readonly kind = "ssh" as const;

  async healthCheck(_node: ExecutionNode, _options?: ExecutionOptions): Promise<NodeHealth> {
    return { online: true, platform: "Linux", architecture: "aarch64", latencyMs: 3 };
  }

  async execute(node: ExecutionNode, request: ExecutionRequest): Promise<ExecutionResult> {
    const now = new Date().toISOString();
    const isWhich = request.executable === "which";
    const target = request.args[0] ?? "";
    const available = isWhich ? ["nmap", "curl", "python3"].includes(target) : ["nmap", "curl", "python3"].includes(request.executable);
    return {
      requestId: request.id,
      nodeId: node.id,
      startedAt: now,
      finishedAt: now,
      exitCode: available ? 0 : 1,
      signal: null,
      timedOut: false,
      cancelled: false,
      stdout: available ? (isWhich ? `/usr/bin/${target}\n` : `${request.executable} test-version\n`) : "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    };
  }
}

test("security service registers and refreshes a Kali SSH node without exposing a shell endpoint", async () => {
  const service = new SecurityService(":memory:", new ServiceFakeProvider());
  try {
    const node = service.registerNode({
      id: "kali-pi",
      name: "Kali Raspberry Pi",
      provider: "ssh",
      host: "192.168.4.42",
      username: "borg",
      workingDirectory: "/home/borg/borg",
    });

    assert.equal(node.status, "unknown");
    assert.equal(service.listNodes().length, 1);

    const refreshed = await service.refreshNode(node.id);
    assert.equal(refreshed.status, "online");
    assert.equal(refreshed.platform, "Linux");
    assert.equal(refreshed.architecture, "aarch64");
    assert.equal(refreshed.capabilities.find((capability) => capability.id === "nmap")?.status, "available");
    assert.equal(refreshed.capabilities.find((capability) => capability.id === "ffuf")?.status, "missing");

    const tools = service.listTools(node.id);
    assert.equal(tools.find((tool) => tool.id === "nmap")?.availability, "available");
    assert.equal(tools.find((tool) => tool.id === "nmap")?.executionMode, "typed_adapter");
    assert.equal(tools.find((tool) => tool.id === "sqlmap")?.availability, "missing");
    assert.equal(tools.find((tool) => tool.id === "sqlmap")?.executionMode, "not_enabled");
  } finally {
    service.close();
  }
});

test("security tool registry is inspectable before a node is selected", () => {
  const service = new SecurityService(":memory:", new ServiceFakeProvider());
  try {
    const tools = service.listTools();
    assert.ok(tools.length >= 20);
    assert.ok(tools.every((tool) => tool.availability === "unknown" && tool.nodeId === null));
    assert.deepEqual(tools.find((tool) => tool.id === "dig")?.operationIds, ["dns_lookup"]);
    assert.equal(tools.find((tool) => tool.id === "hashcat")?.defaultRisk, "intrusive");
  } finally {
    service.close();
  }
});

test("security tool registry rejects an unknown node", () => {
  const service = new SecurityService(":memory:", new ServiceFakeProvider());
  try {
    assert.throws(() => service.listTools("missing"), /was not found/i);
  } finally {
    service.close();
  }
});

test("security service creates a durable assessment with an explicit authorized scope", () => {
  const service = new SecurityService(":memory:", new ServiceFakeProvider());
  try {
    service.registerNode({
      id: "kali-pi",
      name: "Kali Raspberry Pi",
      provider: "ssh",
      host: "kali-pi.local",
      username: "borg",
    });

    const created = service.createAssessment({
      id: "home-lab",
      projectId: "security-home-lab",
      name: "Home Lab Assessment",
      mode: "active_recon",
      executionNodeId: "kali-pi",
      scope: {
        allowedCidrs: ["192.168.4.0/24"],
        excludedHosts: ["192.168.4.1"],
        authorizationConfirmed: true,
      },
    });

    assert.equal(created.assessment.scopeId, "home-lab:scope");
    assert.equal(created.scope.authorizationConfirmed, true);
    const described = service.describeAssessment(created.assessment.id);
    assert.equal(described?.executionNode?.id, "kali-pi");
    assert.deepEqual(described?.scope?.allowedCidrs, ["192.168.4.0/24"]);
    assert.deepEqual(service.listAssessments("security-home-lab").map((assessment) => assessment.id), ["home-lab"]);
  } finally {
    service.close();
  }
});

test("security service reuses a matching SSH node and allows it to be removed", () => {
  const service = new SecurityService(":memory:", new ServiceFakeProvider());
  try {
    const first = service.registerNode({
      name: "Kali Raspberry Pi",
      provider: "ssh",
      host: "192.168.4.70",
      port: 22,
      username: "kali",
    });
    const duplicate = service.registerNode({
      name: "Kali Raspberry Pi duplicate",
      provider: "ssh",
      host: "192.168.4.70",
      port: 22,
      username: "kali",
      securityRuntime: "kali_mcp",
    });

    assert.equal(duplicate.id, first.id);
    assert.equal(duplicate.securityRuntime, "kali_mcp");
    assert.equal(duplicate.name, "Kali Raspberry Pi duplicate");
    assert.equal(service.listNodes().length, 1);
    assert.equal(service.deleteNode(first.id), true);
    assert.equal(service.listNodes().length, 0);
  } finally {
    service.close();
  }
});

test("security service refuses assessments that reference an unknown execution node", () => {
  const service = new SecurityService(":memory:", new ServiceFakeProvider());
  try {
    assert.throws(() => service.createAssessment({
      id: "invalid",
      projectId: "security-invalid",
      name: "Invalid Assessment",
      mode: "active_recon",
      executionNodeId: "missing-node",
      scope: { allowedCidrs: ["192.168.4.0/24"], authorizationConfirmed: true },
    }), /was not found/i);
  } finally {
    service.close();
  }
});
