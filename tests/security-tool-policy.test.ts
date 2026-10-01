import assert from "node:assert/strict";
import test from "node:test";
import { createAssessmentScope, createExecutionNode, createSecurityAssessment } from "../packages/core/src/security-domain.ts";
import { decideSecurityToolRequest } from "../packages/core/src/security-tool-policy.ts";

function fixture(mode: "osint" | "active_recon" = "active_recon") {
  const scope = createAssessmentScope({ id: "scope", allowedDomains: ["example.com"], allowedCidrs: ["192.168.4.0/24"], authorizationConfirmed: true });
  const assessment = createSecurityAssessment({ id: "assessment", projectId: "project", name: "Lab", mode, scopeId: scope.id, executionNodeId: "kali" });
  const node = createExecutionNode({ id: "kali", name: "Kali", provider: "ssh", host: "kali.local", username: "borg" });
  return { scope, assessment, node };
}

test("passive public tools auto-run while active tools require approval", () => {
  const { scope, assessment, node } = fixture();
  const dns = decideSecurityToolRequest({ assessment, scope, node, toolId: "dig", operationId: "dns_lookup", targets: [{ kind: "domain", value: "example.com" }] });
  const nmap = decideSecurityToolRequest({ assessment, scope, node, toolId: "nmap", operationId: "service_inventory", targets: [{ kind: "host", value: "192.168.4.20" }] });
  assert.equal(dns.outcome, "ready");
  assert.equal(dns.approvalRequirement, "none");
  assert.equal(nmap.outcome, "approval_required");
  assert.equal(nmap.approvalRequirement, "execution");
});

test("registry tools without typed adapters remain blocked", () => {
  const { scope, assessment, node } = fixture();
  const result = decideSecurityToolRequest({ assessment, scope, node, toolId: "sqlmap", operationId: "sql_injection_validation", targets: [{ kind: "host", value: "192.168.4.20" }] });
  assert.equal(result.outcome, "blocked");
  assert.equal(result.approvalRequirement, "intrusive");
  assert.match(result.reason, /no enabled typed adapter/i);
});

test("tool policy blocks out-of-scope targets and known missing tools", () => {
  const { scope, assessment, node } = fixture();
  const outside = decideSecurityToolRequest({ assessment, scope, node, toolId: "nmap", operationId: "service_inventory", targets: [{ kind: "host", value: "8.8.8.8" }] });
  assert.equal(outside.outcome, "blocked");
  assert.match(outside.reason, /outside/i);

  const checkedNode = { ...node, capabilities: [{ id: "dig", executable: "dig", category: "dns" as const, status: "missing" as const, version: null, detail: null, checkedAt: new Date().toISOString() }] };
  const missing = decideSecurityToolRequest({ assessment, scope, node: checkedNode, toolId: "dig", operationId: "dns_lookup", targets: [{ kind: "domain", value: "example.com" }] });
  assert.equal(missing.outcome, "blocked");
  assert.match(missing.reason, /missing/i);
});
