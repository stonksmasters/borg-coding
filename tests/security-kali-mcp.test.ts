import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionProvider, ExecutionRequest, ExecutionResult, NodeHealth } from "../packages/core/src/execution-provider.ts";
import type { ExecutionNode } from "../packages/core/src/security-domain.ts";
import type { KaliMcpCallResult, KaliMcpClientProvider, KaliMcpHealth, KaliMcpInvocation } from "../packages/core/src/kali-mcp-provider.ts";
import { SecurityService } from "../apps/server/src/security-service.ts";

class HealthySshProvider implements ExecutionProvider {
  readonly kind = "ssh" as const;
  async healthCheck(): Promise<NodeHealth> {
    return { online: true, platform: "Linux", architecture: "aarch64", latencyMs: 1 };
  }
  async execute(node: ExecutionNode, request: ExecutionRequest): Promise<ExecutionResult> {
    const stdout = request.executable === "which" ? `/usr/bin/${request.args[0]}\n` : "tool version 1\n";
    const now = new Date().toISOString();
    return { requestId: request.id, nodeId: node.id, startedAt: now, finishedAt: now, exitCode: 0, signal: null, timedOut: false, cancelled: false, stdout, stderr: "", stdoutTruncated: false, stderrTruncated: false };
  }
}

class FakeKaliMcpProvider implements KaliMcpClientProvider {
  calls: KaliMcpInvocation[] = [];
  async healthCheck(): Promise<KaliMcpHealth> {
    return {
      online: true, serverName: "kali_mcp", serverVersion: "test",
      tools: [{ name: "execute_command", inputSchema: {} }, { name: "nmap_scan", inputSchema: {} }],
      latencyMs: 1,
    };
  }
  async call(_node: ExecutionNode, invocation: KaliMcpInvocation): Promise<KaliMcpCallResult> {
    this.calls.push(invocation);
    const now = new Date().toISOString();
    return {
      toolName: invocation.mcpTool,
      content: [{ type: "text", text: JSON.stringify({ success: true, output: "[+] GitHub: https://github.com/exampleuser\n" }) }],
      structuredContent: { success: true, output: "[+] GitHub: https://github.com/exampleuser\n" },
      isError: false,
      text: JSON.stringify({ success: true, output: "[+] GitHub: https://github.com/exampleuser\n" }),
      startedAt: now,
      finishedAt: now,
    };
  }
  async disconnect(): Promise<void> {}
  async close(): Promise<void> {}
}

test("Kali MCP dispatch keeps execute_command behind a fixed typed adapter and records identity evidence", async () => {
  const mcp = new FakeKaliMcpProvider();
  const service = new SecurityService(":memory:", new HealthySshProvider(), mcp);
  try {
    service.registerNode({ id: "kali", name: "Kali", provider: "ssh", securityRuntime: "kali_mcp", host: "kali.local", username: "borg" });
    const node = await service.refreshNode("kali");
    assert.equal(node.status, "online");
    assert.equal(node.mcpServerVersion, "test");
    assert.deepEqual(node.mcpTools, ["execute_command", "nmap_scan"]);

    service.createAssessment({
      id: "assessment", projectId: "project", name: "Identity", mode: "osint", executionNodeId: "kali",
      scope: { allowedUsernames: ["exampleuser"] },
    });
    const planned = service.planExecution({
      id: "execution", assessmentId: "assessment", taskId: "task", workflowVersion: 1,
      operation: "public_username_search", classification: "passive",
      targets: [{ kind: "username", value: "exampleuser" }],
    });
    assert.equal(planned.toolDecision.approvalRequirement, "none");
    service.setExecutionStatus("execution", "approved");
    const result = await service.executeApprovedOperation("execution");
    assert.equal(result.execution.status, "succeeded");
    assert.equal(mcp.calls.length, 1);
    assert.equal(mcp.calls[0]?.mcpTool, "execute_command");
    assert.match(String(mcp.calls[0]?.arguments.command), /^'sherlock' /);
    assert.equal(service.listAssets("assessment").some((asset) => asset.kind === "profile"), true);
    const relationship = service.listRelationships("assessment")[0];
    assert.equal(relationship?.confidence, "unverified");
    assert.match(relationship?.rationale ?? "", /candidate/i);
  } finally {
    service.close();
  }
});

test("typed MCP command quoting contains username metacharacters as one argument", () => {
  const service = new SecurityService(":memory:");
  try {
    service.registerNode({ id: "kali", name: "Kali", provider: "ssh", host: "kali.local", username: "borg" });
    service.createAssessment({ id: "assessment", projectId: "project", name: "Identity", mode: "osint", executionNodeId: "kali", scope: { allowedUsernames: ["name;whoami"] } });
    const planned = service.planExecution({
      id: "execution", assessmentId: "assessment", taskId: "task", workflowVersion: 1,
      operation: "public_username_search", classification: "passive",
      targets: [{ kind: "username", value: "name;whoami" }],
    });
    assert.equal(planned.execution.mcpTool, "execute_command");
  } finally {
    service.close();
  }
});
