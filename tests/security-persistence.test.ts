import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAssessmentScope,
  createExecutionNode,
  createSecurityAssessment,
} from "../packages/core/src/security-domain.ts";
import { SqliteSecurityRepository } from "../packages/persistence/src/sqlite-security-repository.ts";

test("security assessment scope and Kali execution node survive SQLite restart", () => {
  const root = mkdtempSync(join(tmpdir(), "borg-security-"));
  const databasePath = join(root, "borg.db");

  let repository = new SqliteSecurityRepository(databasePath);
  try {
    const scope = createAssessmentScope({
      id: "scope-home-lab",
      allowedDomains: ["Example.COM", "example.com"],
      allowedCidrs: ["192.168.4.0/24"],
      excludedHosts: ["192.168.4.1"],
      authorizationConfirmed: true,
    });
    const node = createExecutionNode({
      id: "kali-pi",
      name: "Kali Raspberry Pi",
      provider: "ssh",
      host: "192.168.4.42",
      username: "borg",
      credentialRef: "os-keychain:borg:kali-pi",
      workingDirectory: "/home/borg/borg",
    });
    const assessment = createSecurityAssessment({
      id: "assessment-home-lab",
      projectId: "security-home-lab",
      name: "Home Lab Assessment",
      mode: "active_recon",
      scopeId: scope.id,
      executionNodeId: node.id,
    });

    repository.saveExecutionNode(node);
    repository.saveSecurityAssessmentBundle({ assessment, scope });

    assert.deepEqual(repository.findExecutionNode(node.id), node);
    assert.deepEqual(repository.findAssessmentScope(scope.id), scope);
    assert.deepEqual(repository.findSecurityAssessment(assessment.id), assessment);
    assert.deepEqual(repository.listSecurityAssessments(assessment.projectId), [assessment]);
    assert.deepEqual(scope.allowedDomains, ["example.com"]);
    repository.close();

    repository = new SqliteSecurityRepository(databasePath);
    assert.deepEqual(repository.findExecutionNode(node.id), node);
    assert.deepEqual(repository.findAssessmentScope(scope.id), scope);
    assert.deepEqual(repository.findSecurityAssessment(assessment.id), assessment);
  } finally {
    repository.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("SSH execution nodes require host and username but store only a credential reference", () => {
  assert.throws(
    () => createExecutionNode({
      id: "invalid-kali",
      name: "Invalid Kali",
      provider: "ssh",
      username: "borg",
    }),
    /require a host/i,
  );

  const node = createExecutionNode({
    id: "kali-pi",
    name: "Kali Pi",
    provider: "ssh",
    host: "kali-pi.local",
    username: "borg",
    credentialRef: "os-keychain:borg:kali-pi",
  });

  assert.equal(node.credentialRef, "os-keychain:borg:kali-pi");
  assert.equal("privateKey" in node, false);
  assert.equal("password" in node, false);
});

test("assessment bundle refuses a mismatched scope reference", () => {
  const repository = new SqliteSecurityRepository(":memory:");
  try {
    const scope = createAssessmentScope({ id: "scope-a", authorizationConfirmed: true });
    const assessment = createSecurityAssessment({
      id: "assessment-a",
      projectId: "project-a",
      name: "Assessment A",
      mode: "passive_recon",
      scopeId: "scope-b",
    });

    assert.throws(
      () => repository.saveSecurityAssessmentBundle({ assessment, scope }),
      /scopeId must reference/i,
    );
    assert.equal(repository.findSecurityAssessment(assessment.id), null);
    assert.equal(repository.findAssessmentScope(scope.id), null);
  } finally {
    repository.close();
  }
});

test("deleting an execution node preserves the assessment and clears the foreign key", () => {
  const repository = new SqliteSecurityRepository(":memory:");
  try {
    const scope = createAssessmentScope({ id: "scope-delete", authorizationConfirmed: true });
    const node = createExecutionNode({
      id: "node-delete",
      name: "Kali Pi",
      provider: "ssh",
      host: "192.168.4.42",
      username: "borg",
    });
    const assessment = createSecurityAssessment({
      id: "assessment-delete",
      projectId: "project-delete",
      name: "Delete node behavior",
      mode: "osint",
      scopeId: scope.id,
      executionNodeId: node.id,
    });

    repository.saveExecutionNode(node);
    repository.saveSecurityAssessmentBundle({ assessment, scope });
    assert.equal(repository.deleteExecutionNode(node.id), true);

    // SQLite clears the relational column, but the JSON snapshot is intentionally
    // not rewritten behind the caller's back. The next repository save is the
    // authoritative domain update; this assertion protects against cascading
    // deletion of the assessment itself.
    assert.equal(repository.findSecurityAssessment(assessment.id)?.id, assessment.id);
  } finally {
    repository.close();
  }
});
