import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { SecurityService } from "../apps/server/src/security-service.ts";
import type { ExecutionNode } from "../packages/core/src/security-domain.ts";
import type { ExecutionProvider, ExecutionRequest, ExecutionResult, NodeHealth } from "../packages/core/src/execution-provider.ts";

class ProfileProvider implements ExecutionProvider {
  readonly kind = "ssh" as const;
  active = 0;
  maxActive = 0;
  operations: string[] = [];
  async healthCheck(): Promise<NodeHealth> { return { online: true, platform: "Linux", architecture: "aarch64", latencyMs: 1 }; }
  async execute(node: ExecutionNode, request: ExecutionRequest): Promise<ExecutionResult> {
    const now = new Date().toISOString();
    let exitCode = 0; let stdout = "";
    if (request.executable === "which") stdout = `/usr/bin/${request.args[0]}\n`;
    else if (request.args.includes("--version") || request.args.includes("-v")) stdout = `${request.executable} test\n`;
    else {
      this.active += 1; this.maxActive = Math.max(this.maxActive, this.active); this.operations.push(request.executable);
      await delay(10);
      if (request.executable === "sherlock") stdout = "[+] Example: https://social.example/test_user\n";
      else if (request.executable === "maigret") stdout = "[*] Short text report:\nSearch by username test_user returned 0 accounts.\n";
      else if (request.executable === "holehe") stdout = "[+] github\n";
      else if (request.executable === "theHarvester") stdout = "person@example.com\n";
      else if (request.executable === "phoneinfoga") stdout = "Country: US\n";
      else if (request.executable === "dig") stdout = "example.com. 300 IN A 192.0.2.1\n";
      else if (request.executable === "dnsrecon") stdout = "[]\n";
      else if (request.executable === "whatweb") stdout = '[{"plugins":{"HTML5":{}}}]';
      else if (request.executable === "gobuster") stdout = "/admin (Status: 200)\n";
      else exitCode = 1;
      this.active -= 1;
    }
    return { requestId: request.id, nodeId: node.id, startedAt: now, finishedAt: new Date().toISOString(), exitCode, signal: null, timedOut: false, cancelled: false, stdout, stderr: "", stdoutTruncated: false, stderrTruncated: false };
  }
}

async function waitForJobs(service: SecurityService, profileIds: string[]) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const jobs = profileIds.flatMap((id) => service.describeProfile(id)?.jobs ?? []);
    if (jobs.length && jobs.every((job) => ["succeeded", "failed", "cancelled"].includes(job.status))) return jobs;
    await delay(10);
  }
  throw new Error("Profile jobs did not finish.");
}

async function configured(path: string, provider: ProfileProvider) {
  const service = new SecurityService(path, provider);
  service.registerNode({ id: "kali", name: "Kali", provider: "ssh", host: "10.77.0.2", username: "kali" });
  await service.refreshNode("kali");
  return service;
}

test("identity profiles and identifier decisions survive restart and stay out of Cases", async () => {
  const root = mkdtempSync(join(tmpdir(), "borg-profiles-"));
  const path = join(root, "borg.db");
  const provider = new ProfileProvider();
  let service = await configured(path, provider);
  try {
    const created = service.createProfile({ projectId: "security-local", displayName: "Test Person", notes: "durable", executionNodeId: "kali", identifiers: [{ kind: "username", value: "Test_User" }, { kind: "email", value: "Person@Example.com" }] });
    assert.ok(created);
    const profileId = created!.profile.id;
    const candidate = service.addProfileIdentifier(profileId, { kind: "url", value: "https://social.example/test_user", status: "candidate", source: "tool", confidence: "possible" });
    service.setProfileIdentifierStatus(profileId, candidate.id, "rejected");
    assert.equal(service.listCases("security-local").length, 0);
    service.close();

    service = new SecurityService(path, provider);
    const restored = service.describeProfile(profileId);
    assert.equal(restored?.profile.notes, "durable");
    assert.deepEqual(restored?.identifiers.map((item) => [item.kind, item.normalizedValue, item.status]), [
      ["email", "person@example.com", "confirmed"], ["url", "https://social.example/test_user", "rejected"], ["username", "test_user", "confirmed"],
    ]);
    assert.deepEqual(restored?.assessment?.scope?.allowedUsernames, ["test_user"]);
    assert.deepEqual(restored?.assessment?.scope?.excludedUrls, ["https://social.example/test_user"]);
  } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
});

test("profile queue serializes jobs, deduplicates active work, and creates review candidates", async () => {
  const provider = new ProfileProvider();
  const service = await configured(":memory:", provider);
  try {
    const first = service.createProfile({ projectId: "security-local", displayName: "First", executionNodeId: "kali", identifiers: [{ kind: "username", value: "test_user" }, { kind: "email", value: "person@example.com" }] })!;
    const second = service.createProfile({ projectId: "security-local", displayName: "Second", executionNodeId: "kali", identifiers: [{ kind: "phone", value: "+1 202 555 0123" }] })!;
    const username = first.identifiers.find((item) => item.kind === "username")!;
    const job = service.enqueueProfileJob(first.profile.id, { operation: "public_username_search", identifierId: username.id });
    assert.equal(service.enqueueProfileJob(first.profile.id, { operation: "public_username_search", identifierId: username.id }).id, job.id);
    service.enqueuePassiveSuite(first.profile.id);
    service.enqueuePassiveSuite(second.profile.id);
    const jobs = await waitForJobs(service, [first.profile.id, second.profile.id]);
    assert.ok(jobs.every((item) => item.status === "succeeded"));
    assert.equal(provider.maxActive, 1);
    const refreshed = service.describeProfile(first.profile.id)!;
    assert.ok(refreshed.identifiers.some((item) => item.kind === "url" && item.status === "candidate" && item.source === "tool"));
    assert.equal(new Set(refreshed.jobs.map((item) => `${item.operation}:${item.target.value}`)).size, refreshed.jobs.length);
  } finally { service.close(); }
});

test("candidate and rejected identifiers cannot be used as profile tool targets", async () => {
  const provider = new ProfileProvider();
  const service = await configured(":memory:", provider);
  try {
    const detail = service.createProfile({ projectId: "security-local", displayName: "Candidate", executionNodeId: "kali" })!;
    const candidate = service.addProfileIdentifier(detail.profile.id, { kind: "username", value: "maybe_user", status: "candidate", source: "tool", confidence: "possible" });
    assert.throws(() => service.enqueueProfileJob(detail.profile.id, { operation: "public_username_search", identifierId: candidate.id }), /confirmed identifiers/i);
    service.setProfileIdentifierStatus(detail.profile.id, candidate.id, "rejected");
    assert.throws(() => service.enqueueProfileJob(detail.profile.id, { operation: "public_username_search", identifierId: candidate.id }), /confirmed identifiers/i);
  } finally { service.close(); }
});

test("active profile jobs require saved authorization and explicit approval across restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "borg-profile-approval-"));
  const path = join(root, "borg.db");
  const provider = new ProfileProvider();
  let service = await configured(path, provider);
  try {
    const blocked = service.createProfile({ projectId: "security-local", displayName: "Blocked", executionNodeId: "kali", identifiers: [{ kind: "url", value: "https://example.com" }] })!;
    const blockedUrl = blocked.identifiers[0];
    assert.throws(() => service.enqueueProfileJob(blocked.profile.id, { operation: "web_content_discovery", identifierId: blockedUrl.id }), /authorization/i);

    const allowed = service.createProfile({ projectId: "security-local", displayName: "Allowed", executionNodeId: "kali", authorizationConfirmed: true, identifiers: [{ kind: "url", value: "https://example.com" }] })!;
    const job = service.enqueueProfileJob(allowed.profile.id, { operation: "web_content_discovery", identifierId: allowed.identifiers[0].id });
    assert.equal(job.status, "awaiting_approval");
    service.close();

    service = new SecurityService(path, provider);
    assert.equal(service.describeProfile(allowed.profile.id)?.jobs[0].status, "awaiting_approval");
    service.approveProfileJob(job.id);
    const [completed] = await waitForJobs(service, [allowed.profile.id]);
    assert.equal(completed.status, "succeeded");
  } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
});
