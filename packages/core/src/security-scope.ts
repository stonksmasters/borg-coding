import {
  AssessmentScopeSchema,
  type AssessmentScope,
  type SecurityTarget,
} from "./security-domain.ts";

export type { SecurityTarget } from "./security-domain.ts";

export type ScopeDecision = {
  allowed: boolean;
  normalizedTarget: string;
  reason: string;
  matchedRule: string | null;
};

type Ipv4Range = {
  start: number;
  end: number;
  prefix: number;
  normalized: string;
};

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function parseIpv4(value: string): number | null {
  const parts = value.trim().split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return null;
    result = (result * 256) + octet;
  }
  return result >>> 0;
}

function formatIpv4(value: number): string {
  const unsigned = value >>> 0;
  return [
    (unsigned >>> 24) & 255,
    (unsigned >>> 16) & 255,
    (unsigned >>> 8) & 255,
    unsigned & 255,
  ].join(".");
}

function parseIpv4Cidr(value: string): Ipv4Range | null {
  const match = /^([^/]+)\/(\d{1,2})$/.exec(value.trim());
  if (!match) return null;
  const address = parseIpv4(match[1] ?? "");
  const prefix = Number(match[2]);
  if (address === null || prefix < 0 || prefix > 32) return null;

  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const start = (address & mask) >>> 0;
  const size = 2 ** (32 - prefix);
  const end = (start + size - 1) >>> 0;
  return {
    start,
    end,
    prefix,
    normalized: `${formatIpv4(start)}/${prefix}`,
  };
}

function rangeContains(container: Ipv4Range, candidate: Ipv4Range): boolean {
  return candidate.start >= container.start && candidate.end <= container.end;
}

function rangesOverlap(left: Ipv4Range, right: Ipv4Range): boolean {
  return left.start <= right.end && right.start <= left.end;
}

function domainRuleMatches(ruleInput: string, targetInput: string): boolean {
  const rule = normalizeName(ruleInput);
  const target = normalizeName(targetInput);
  if (!rule || !target) return false;
  if (!rule.startsWith("*.")) return target === rule;
  const suffix = rule.slice(2);
  return target.length > suffix.length && target.endsWith(`.${suffix}`);
}

function findMatchingDomainRule(rules: readonly string[], target: string): string | null {
  return rules.find((rule) => domainRuleMatches(rule, target)) ?? null;
}

function findMatchingHostRule(rules: readonly string[], target: string): string | null {
  const normalized = normalizeName(target);
  return rules.find((rule) => normalizeName(rule) === normalized) ?? null;
}

function findContainingCidr(rules: readonly string[], candidate: Ipv4Range): string | null {
  for (const rule of rules) {
    const parsed = parseIpv4Cidr(rule);
    if (parsed && rangeContains(parsed, candidate)) return parsed.normalized;
  }
  return null;
}

function findOverlappingCidr(rules: readonly string[], candidate: Ipv4Range): string | null {
  for (const rule of rules) {
    const parsed = parseIpv4Cidr(rule);
    if (parsed && rangesOverlap(parsed, candidate)) return parsed.normalized;
  }
  return null;
}

export function evaluateScopeTarget(scopeInput: AssessmentScope, target: SecurityTarget): ScopeDecision {
  const scope = AssessmentScopeSchema.parse(scopeInput);

  if (target.kind === "file" || target.kind === "query") {
    const normalized = target.kind === "query" ? target.value.trim().toLowerCase() : target.value.trim().replaceAll("\\", "/");
    const allowedValues = target.kind === "file" ? scope.allowedFiles : scope.allowedQueries;
    const excludedValues = target.kind === "file" ? scope.excludedFiles : scope.excludedQueries;
    const normalize = (value: string) => target.kind === "query" ? value.trim().toLowerCase() : value.trim().replaceAll("\\", "/");
    const excluded = excludedValues.find((value) => normalize(value) === normalized) ?? null;
    if (excluded) return { allowed: false, normalizedTarget: normalized, reason: "Target matches an explicit exclusion.", matchedRule: excluded };
    const allowed = allowedValues.find((value) => normalize(value) === normalized) ?? null;
    return allowed
      ? { allowed: true, normalizedTarget: normalized, reason: "Local analysis target is inside the assessment scope.", matchedRule: allowed }
      : { allowed: false, normalizedTarget: normalized, reason: "Local analysis target is outside the assessment scope.", matchedRule: null };
  }

  if (target.kind === "email" || target.kind === "username" || target.kind === "phone" || target.kind === "url") {
    const normalized = normalizeName(target.value);
    const allowedValues = target.kind === "email"
      ? scope.allowedEmails
      : target.kind === "username"
        ? scope.allowedUsernames
        : target.kind === "phone"
          ? scope.allowedPhones
          : scope.allowedUrls;
    const excludedValues = target.kind === "email"
      ? scope.excludedEmails
      : target.kind === "username"
        ? scope.excludedUsernames
        : target.kind === "phone"
          ? scope.excludedPhones
          : scope.excludedUrls;
    if (excludedValues.some((value) => normalizeName(value) === normalized)) return { allowed: false, normalizedTarget: normalized, reason: "Target matches an explicit exclusion.", matchedRule: normalized };
    const matched = allowedValues.find((value) => normalizeName(value) === normalized) ?? null;
    return matched
      ? { allowed: true, normalizedTarget: normalized, reason: "Identity target is inside the assessment scope.", matchedRule: matched }
      : { allowed: false, normalizedTarget: normalized, reason: "Identity target is outside the assessment scope.", matchedRule: null };
  }

  if (target.kind === "domain") {
    const normalized = normalizeName(target.value);
    if (!normalized) return { allowed: false, normalizedTarget: normalized, reason: "Domain target is empty.", matchedRule: null };

    const excluded = findMatchingDomainRule(scope.excludedDomains, normalized)
      ?? findMatchingHostRule(scope.excludedHosts, normalized);
    if (excluded) {
      return { allowed: false, normalizedTarget: normalized, reason: "Target matches an explicit exclusion.", matchedRule: excluded };
    }

    const allowed = findMatchingDomainRule(scope.allowedDomains, normalized)
      ?? findMatchingHostRule(scope.allowedHosts, normalized);
    return allowed
      ? { allowed: true, normalizedTarget: normalized, reason: "Target is inside the assessment scope.", matchedRule: allowed }
      : { allowed: false, normalizedTarget: normalized, reason: "Target is outside the assessment scope.", matchedRule: null };
  }

  if (target.kind === "host") {
    const normalized = normalizeName(target.value);
    if (!normalized) return { allowed: false, normalizedTarget: normalized, reason: "Host target is empty.", matchedRule: null };

    const address = parseIpv4(normalized);
    if (address !== null) {
      const candidate: Ipv4Range = { start: address, end: address, prefix: 32, normalized: `${formatIpv4(address)}/32` };
      const excludedHost = findMatchingHostRule(scope.excludedHosts, normalized);
      const excludedCidr = findOverlappingCidr(scope.excludedCidrs, candidate);
      if (excludedHost || excludedCidr) {
        return {
          allowed: false,
          normalizedTarget: formatIpv4(address),
          reason: "Target matches an explicit exclusion.",
          matchedRule: excludedHost ?? excludedCidr,
        };
      }

      const allowedHost = findMatchingHostRule(scope.allowedHosts, normalized);
      const allowedCidr = findContainingCidr(scope.allowedCidrs, candidate);
      return allowedHost || allowedCidr
        ? {
            allowed: true,
            normalizedTarget: formatIpv4(address),
            reason: "Target is inside the assessment scope.",
            matchedRule: allowedHost ?? allowedCidr,
          }
        : {
            allowed: false,
            normalizedTarget: formatIpv4(address),
            reason: "Target is outside the assessment scope.",
            matchedRule: null,
          };
    }

    const excluded = findMatchingHostRule(scope.excludedHosts, normalized)
      ?? findMatchingDomainRule(scope.excludedDomains, normalized);
    if (excluded) {
      return { allowed: false, normalizedTarget: normalized, reason: "Target matches an explicit exclusion.", matchedRule: excluded };
    }

    const allowed = findMatchingHostRule(scope.allowedHosts, normalized)
      ?? findMatchingDomainRule(scope.allowedDomains, normalized);
    return allowed
      ? { allowed: true, normalizedTarget: normalized, reason: "Target is inside the assessment scope.", matchedRule: allowed }
      : { allowed: false, normalizedTarget: normalized, reason: "Target is outside the assessment scope.", matchedRule: null };
  }

  const candidate = parseIpv4Cidr(target.value);
  if (!candidate) {
    return {
      allowed: false,
      normalizedTarget: target.value.trim(),
      reason: "CIDR target is invalid or unsupported. IPv4 CIDR is required in this version.",
      matchedRule: null,
    };
  }

  const excluded = findOverlappingCidr(scope.excludedCidrs, candidate)
    ?? scope.excludedHosts.find((host) => {
      const address = parseIpv4(host);
      return address !== null && address >= candidate.start && address <= candidate.end;
    })
    ?? null;
  if (excluded) {
    return {
      allowed: false,
      normalizedTarget: candidate.normalized,
      reason: "Requested network overlaps an explicit exclusion.",
      matchedRule: excluded,
    };
  }

  const allowed = findContainingCidr(scope.allowedCidrs, candidate);
  return allowed
    ? {
        allowed: true,
        normalizedTarget: candidate.normalized,
        reason: "Requested network is fully contained by the assessment scope.",
        matchedRule: allowed,
      }
    : {
        allowed: false,
        normalizedTarget: candidate.normalized,
        reason: "Requested network is not fully contained by the assessment scope.",
        matchedRule: null,
      };
}

export function assertTargetInScope(scope: AssessmentScope, target: SecurityTarget): ScopeDecision {
  const decision = evaluateScopeTarget(scope, target);
  if (!decision.allowed) throw new Error(`Security target rejected: ${decision.reason} (${decision.normalizedTarget})`);
  return decision;
}
