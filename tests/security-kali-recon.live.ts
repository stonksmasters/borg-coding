import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SecurityService } from "../apps/server/src/security-service.ts";

const host = process.env.BORG_KALI_HOST?.trim();
const username = process.env.BORG_KALI_USER?.trim() || "kali";
if (!host) throw new Error("BORG_KALI_HOST is required for the opt-in Kali recon integration test.");

test("live Kali MCP recon adapters normalize real tool output", async () => {
  const root = mkdtempSync(join(tmpdir(), "borg-kali-recon-live-"));
  const service = new SecurityService(join(root, "borg.db"));
  try {
    service.registerNode({ id: "kali", name: "Kali", provider: "ssh", securityRuntime: "kali_mcp", host, username });
    const node = await service.refreshNode("kali");
    assert.equal(node.status, "online", node.lastError ?? undefined);
    service.createAssessment({
      id: "recon",
      projectId: "live-kali-recon",
      name: "Live recon adapter validation",
      mode: "authorized_assessment",
      executionNodeId: node.id,
      scope: {
        allowedDomains: ["example.com"],
        allowedEmails: ["test@example.com"],
        allowedUsernames: ["borg-recon-probe-20260929"],
        allowedPhones: ["+12025550123"],
        allowedUrls: ["https://example.com", "http://127.0.0.1:5000"],
        authorizationConfirmed: true,
      },
    });

    async function run(operation: string, classification: "passive" | "active_recon", kind: "domain" | "email" | "username" | "phone" | "url", value: string) {
      const id = randomUUID();
      service.planExecution({ id, assessmentId: "recon", taskId: `task-${id}`, workflowVersion: 1, operation, classification, targets: [{ kind, value }] });
      service.setExecutionStatus(id, "approved");
      const output = await service.executeApprovedOperation(id);
      const diagnostic = output.execution.status === "succeeded"
        ? undefined
        : JSON.stringify({ error: output.execution.error, evidence: output.evidence.map((item) => ({ kind: item.kind, text: item.inlineText })) }, null, 2);
      assert.equal(output.execution.status, "succeeded", diagnostic);
      assert.ok(output.normalized);
      return output.normalized as Record<string, unknown>;
    }

    const domain = await run("domain_recon", "passive", "domain", "example.com");
    assert.ok((domain.records as unknown[]).length > 0);
    const web = await run("web_fingerprint", "passive", "url", "https://example.com");
    assert.ok((web.technologies as string[]).length > 0);
    const phone = await run("phone_enrichment", "passive", "phone", "+12025550123");
    assert.ok((phone.references as string[]).length > 0);
    await run("email_account_search", "passive", "email", "test@example.com");
    await run("maigret_username_search", "passive", "username", "borg-recon-probe-20260929");
    const paths = await run("web_content_discovery", "active_recon", "url", "http://127.0.0.1:5000");
    assert.ok(Array.isArray(paths.paths));
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
