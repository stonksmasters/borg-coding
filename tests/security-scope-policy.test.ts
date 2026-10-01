import assert from "node:assert/strict";
import test from "node:test";
import {
  createAssessmentScope,
  createSecurityAssessment,
} from "../packages/core/src/security-domain.ts";
import {
  assertTargetInScope,
  evaluateScopeTarget,
} from "../packages/core/src/security-scope.ts";
import {
  authorizeSecurityOperation,
} from "../packages/core/src/security-policy.ts";

test("scope validator permits hosts inside an allowed CIDR and blocks explicit exclusions", () => {
  const scope = createAssessmentScope({
    id: "scope-lan",
    allowedCidrs: ["192.168.4.0/24"],
    excludedHosts: ["192.168.4.1"],
    authorizationConfirmed: true,
  });

  assert.equal(evaluateScopeTarget(scope, { kind: "host", value: "192.168.4.42" }).allowed, true);
  const gateway = evaluateScopeTarget(scope, { kind: "host", value: "192.168.4.1" });
  assert.equal(gateway.allowed, false);
  assert.match(gateway.reason, /exclusion/i);
  assert.throws(() => assertTargetInScope(scope, { kind: "host", value: "8.8.8.8" }), /outside/i);
});

test("domain wildcard scope does not silently include the apex and exclusions win", () => {
  const scope = createAssessmentScope({
    id: "scope-domain",
    allowedDomains: ["*.example.com", "example.com"],
    excludedDomains: ["admin.example.com"],
  });

  assert.equal(evaluateScopeTarget(scope, { kind: "domain", value: "api.EXAMPLE.com." }).allowed, true);
  assert.equal(evaluateScopeTarget(scope, { kind: "domain", value: "example.com" }).allowed, true);
  assert.equal(evaluateScopeTarget(scope, { kind: "domain", value: "admin.example.com" }).allowed, false);

  const wildcardOnly = createAssessmentScope({
    id: "scope-wildcard",
    allowedDomains: ["*.example.com"],
  });
  assert.equal(evaluateScopeTarget(wildcardOnly, { kind: "domain", value: "example.com" }).allowed, false);
});

test("CIDR requests must be fully contained and may not overlap exclusions", () => {
  const scope = createAssessmentScope({
    id: "scope-cidr",
    allowedCidrs: ["10.20.0.0/16"],
    excludedCidrs: ["10.20.10.0/24"],
    authorizationConfirmed: true,
  });

  assert.equal(evaluateScopeTarget(scope, { kind: "cidr", value: "10.20.20.0/24" }).allowed, true);
  assert.equal(evaluateScopeTarget(scope, { kind: "cidr", value: "10.20.10.0/25" }).allowed, false);
  assert.equal(evaluateScopeTarget(scope, { kind: "cidr", value: "10.0.0.0/8" }).allowed, false);
  assert.equal(evaluateScopeTarget(scope, { kind: "cidr", value: "2001:db8::/64" }).allowed, false);
});

test("file and software analysis targets require exact saved scope entries", () => {
  const scope = createAssessmentScope({
    id: "scope-evidence",
    allowedFiles: ["/home/kali/evidence/sample.bin"],
    allowedQueries: ["Apache 2.4"],
    excludedFiles: ["/home/kali/evidence/private.bin"],
  });
  assert.equal(evaluateScopeTarget(scope, { kind: "file", value: "/home/kali/evidence/sample.bin" }).allowed, true);
  assert.equal(evaluateScopeTarget(scope, { kind: "file", value: "/home/kali/evidence/other.bin" }).allowed, false);
  assert.equal(evaluateScopeTarget(scope, { kind: "file", value: "/home/kali/evidence/private.bin" }).allowed, false);
  assert.equal(evaluateScopeTarget(scope, { kind: "query", value: "apache 2.4" }).allowed, true);
});

test("active recon fails closed until scope authorization is confirmed", () => {
  const scope = createAssessmentScope({
    id: "scope-unconfirmed",
    allowedCidrs: ["192.168.4.0/24"],
  });
  const assessment = createSecurityAssessment({
    id: "assessment-active",
    projectId: "project-security",
    name: "Active recon",
    mode: "active_recon",
    scopeId: scope.id,
  });

  const decision = authorizeSecurityOperation({
    assessment,
    scope,
    request: {
      operation: "service_discovery",
      classification: "active_recon",
      targets: [{ kind: "host", value: "192.168.4.42" }],
    },
  });

  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /authorization/i);
});

test("passive mode cannot authorize active recon and autonomous policy never authorizes manual operations", () => {
  const scope = createAssessmentScope({
    id: "scope-passive",
    allowedDomains: ["example.com"],
    authorizationConfirmed: true,
  });
  const assessment = createSecurityAssessment({
    id: "assessment-passive",
    projectId: "project-passive",
    name: "Passive recon",
    mode: "passive_recon",
    scopeId: scope.id,
  });

  const active = authorizeSecurityOperation({
    assessment,
    scope,
    request: {
      operation: "service_discovery",
      classification: "active_recon",
      targets: [{ kind: "domain", value: "example.com" }],
    },
  });
  assert.equal(active.allowed, false);

  const manual = authorizeSecurityOperation({
    assessment: { ...assessment, mode: "authorized_assessment" },
    scope,
    request: {
      operation: "manual_terminal",
      classification: "manual",
      targets: [{ kind: "domain", value: "example.com" }],
    },
  });
  assert.equal(manual.allowed, false);
  assert.match(manual.reason, /manual/i);
});
