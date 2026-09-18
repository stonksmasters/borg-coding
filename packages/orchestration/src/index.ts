import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  engineeringDisciplines,
  engineeringRoles,
  type EngineeringDiscipline,
  type EngineeringRole,
  type RiskLevel,
  type SpecialistPackRef,
} from "../../core/src/contracts.ts";

const RolePolicySchema = z.object({
  model: z.string().min(1).max(200).nullable().default(null),
}).strict();

const DisciplinePolicySchema = z.object({
  model: z.string().min(1).max(200).nullable().default(null),
}).strict();

export const TeamPolicySchema = z.object({
  version: z.literal(1),
  defaultDiscipline: z.enum(engineeringDisciplines).default("general"),
  roles: z.object({
    architect: RolePolicySchema.default({ model: null }),
    implementer: RolePolicySchema.default({ model: null }),
    verifier: RolePolicySchema.default({ model: null }),
    reviewer: RolePolicySchema.default({ model: null }),
  }).strict().default({
    architect: { model: null },
    implementer: { model: null },
    verifier: { model: null },
    reviewer: { model: null },
  }),
  disciplines: z.record(z.enum(engineeringDisciplines), DisciplinePolicySchema).default({}),
}).strict();

export type TeamPolicy = z.infer<typeof TeamPolicySchema>;

export interface DisciplineRoute {
  primary: EngineeringDiscipline;
  disciplines: EngineeringDiscipline[];
  reasons: string[];
}

export interface SpecialistCapabilityPack {
  id: string;
  version: number;
  label: string;
  discipline: EngineeringDiscipline;
  instructions: Readonly<Record<EngineeringRole, readonly string[]>>;
  toolCapabilities: readonly string[];
  requiredEvidence: readonly string[];
  verificationProfile: "quick" | "full";
  requiresBrowserEvidence: boolean;
  riskRules: readonly string[];
  failureCategories: readonly string[];
  escalationRules: readonly string[];
  minimumRisk: RiskLevel;
}

export interface SpecialistEvidenceResult {
  passed: boolean;
  requirements: string[];
  failures: string[];
}

const signals: { discipline: EngineeringDiscipline; pattern: RegExp; reason: string }[] = [
  { discipline: "security", pattern: /\b(auth|authorization|permission|credential|secret|security|vulnerab|encrypt|csrf|xss|injection)\b/i, reason: "security-sensitive request" },
  { discipline: "database", pattern: /\b(database|postgres|sqlite|schema|migration|query|index|sql|supabase)\b/i, reason: "database or persistence work" },
  { discipline: "devops", pattern: /\b(ci|pipeline|deploy|docker|container|vercel|workflow|release|build system)\b/i, reason: "delivery or build-system work" },
  { discipline: "infrastructure", pattern: /\b(terraform|kubernetes|network|firewall|cloud|infrastructure|server provisioning)\b/i, reason: "infrastructure work" },
  { discipline: "frontend", pattern: /\b(ui|ux|frontend|react|next\.js|css|tailwind|responsive|browser|component|page|layout)\b/i, reason: "browser-interface work" },
  { discipline: "backend", pattern: /\b(api|backend|server|endpoint|webhook|queue|worker|service)\b/i, reason: "server-side work" },
  { discipline: "qa", pattern: /\b(test|verification|regression|quality|playwright|accessibility|coverage)\b/i, reason: "verification-focused work" },
];

const extensionSignals: { pattern: RegExp; discipline: EngineeringDiscipline }[] = [
  { pattern: /\.(tsx|jsx|css|scss|html)$/i, discipline: "frontend" },
  { pattern: /(^|\/)(api|server|routes?|controllers?|services?)(\/|$)|\.(cs|go|rs|py)$/i, discipline: "backend" },
  { pattern: /(^|\/)(migrations?|schema|database|db)(\/|$)|\.sql$/i, discipline: "database" },
  { pattern: /(^|\/)(tests?|__tests__|e2e)(\/|$)|\.(test|spec)\./i, discipline: "qa" },
  { pattern: /(^|\/)(\.github|docker|infra|terraform)(\/|$)|Dockerfile/i, discipline: "devops" },
];

const roleInstructions = (
  architect: readonly string[],
  implementer: readonly string[],
  verifier: readonly string[],
  reviewer: readonly string[],
): Readonly<Record<EngineeringRole, readonly string[]>> => ({ architect, implementer, verifier, reviewer });

const commonTools = ["repository_*", "web_search", "web_fetch", "worktree_read", "worktree_patch", "worktree_command", "git_status", "git_diff", "verification_*"] as const;
const browserTools = [...commonTools, "browser_*"] as const;

const specialistPacks: Readonly<Record<EngineeringDiscipline, SpecialistCapabilityPack>> = {
  general: {
    id: "general.core", version: 1, label: "General Software Engineering", discipline: "general",
    instructions: roleInstructions(
      ["Map the request to concrete repository boundaries, dependencies, risks, and acceptance evidence."],
      ["Prefer the smallest coherent change and preserve existing contracts unless the approved plan requires otherwise."],
      ["Run the strongest detected deterministic profile and report unsupported verification explicitly."],
      ["Review correctness, regressions, requirements, and maintainability only from supplied evidence."],
    ),
    toolCapabilities: browserTools,
    requiredEvidence: ["Relevant deterministic checks pass.", "The final Git diff is inspected."],
    verificationProfile: "quick", requiresBrowserEvidence: false, minimumRisk: "R1",
    riskRules: ["Escalate changes that cross trust, data, deployment, or destructive boundaries."],
    failureCategories: ["correctness", "regression", "requirements", "maintainability"],
    escalationRules: ["Block when high-impact behavior cannot be verified deterministically."],
  },
  frontend: {
    id: "frontend.web", version: 2, label: "Frontend Engineering", discipline: "frontend",
    instructions: roleInstructions(
      [
        "Identify affected routes, components, state boundaries, responsive behavior, accessibility expectations, and whether the request requires deliberate visual art direction.",
        "For greenfield or redesign work, plan composition and page rhythm before component details; avoid treating card grids as the default information architecture.",
      ],
      [
        "Treat any persisted Design Brief as a hard product requirement. Implement its hierarchy, composition, typography, palette direction, content voice, mobile strategy, and explicit avoid-list rather than using generic AI website defaults.",
        "Build a coherent design language with reusable tokens and primitives. Prefer deliberate editorial composition, meaningful focal points, varied section weight, strong typography hierarchy, credible copy, and restrained motion.",
        "Do not fabricate testimonials, logos, ratings, awards, client counts, revenue, performance metrics, or other social proof. Do not use lorem ipsum or vague filler copy.",
        "Mobile must be intentionally art-directed rather than merely stacking desktop sections. Verify behavior through DOM interaction, console/network evidence, responsive screenshots, and accessibility checks.",
      ],
      [
        "Require browser evidence for changed user-facing behavior and reject serious accessibility, console, network, visual, or responsive failures.",
        "For design-directed tasks, preserve mobile and desktop screenshots suitable for the independent Visual Director quality gate.",
      ],
      [
        "Review interaction states, responsive layouts, accessibility, visual regressions, client/server boundaries, hierarchy, typography, section rhythm, composition, content credibility, and visible design-system consistency.",
        "Do not approve a design-directed interface merely because it is functional; verified visual quality is a separate requirement.",
      ],
    ),
    toolCapabilities: browserTools,
    requiredEvidence: ["Browser evidence exists and passes.", "Responsive and accessibility evidence covers the changed interface.", "The final Git diff is inspected."],
    verificationProfile: "quick", requiresBrowserEvidence: true, minimumRisk: "R1",
    riskRules: ["Treat authentication UI, destructive actions, and sensitive-data rendering as security-sensitive."],
    failureCategories: ["interaction", "responsive", "accessibility", "visual-regression", "visual-quality", "content-credibility", "client-runtime"],
    escalationRules: ["Block when the changed interface cannot be exercised locally or required browser evidence is missing.", "Design-directed work cannot claim premium completion without independent aesthetic evidence."],
  },
  backend: {
    id: "backend.services", version: 1, label: "Backend Engineering", discipline: "backend",
    instructions: roleInstructions(
      ["Map API contracts, trust boundaries, callers, side effects, error semantics, and compatibility constraints."],
      ["Preserve request/response contracts, validate inputs, make side effects explicit, and add focused service tests."],
      ["Verify API contracts, failure paths, authorization boundaries, idempotency where relevant, and deterministic tests."],
      ["Review compatibility, validation, error handling, concurrency, observability, and side-effect safety."],
    ),
    toolCapabilities: commonTools,
    requiredEvidence: ["Affected API or service contracts are covered by deterministic tests.", "Failure behavior is inspected.", "The final Git diff is inspected."],
    verificationProfile: "quick", requiresBrowserEvidence: false, minimumRisk: "R1",
    riskRules: ["Escalate externally visible contract changes, unbounded work, and privileged side effects."],
    failureCategories: ["api-contract", "validation", "authorization", "concurrency", "side-effect"],
    escalationRules: ["Block incompatible contract changes without an explicit migration or compatibility plan."],
  },
  database: {
    id: "database.persistence", version: 1, label: "Database Engineering", discipline: "database",
    instructions: roleInstructions(
      ["Map schemas, migrations, constraints, indexes, transaction boundaries, data volume, and rollback requirements."],
      ["Prefer forward-compatible migrations, explicit constraints, bounded queries, and transactional state changes."],
      ["Run the full verification profile and inspect migration safety, rollback behavior, integrity constraints, and query coverage."],
      ["Review data-loss risk, migration ordering, transactionality, compatibility, query correctness, and indexes."],
    ),
    toolCapabilities: commonTools,
    requiredEvidence: ["The full deterministic profile passes.", "Schema or migration behavior is tested.", "Rollback and data-loss risks are addressed.", "The final Git diff is inspected."],
    verificationProfile: "full", requiresBrowserEvidence: false, minimumRisk: "R2",
    riskRules: ["Treat destructive schema changes, backfills, and constraint changes as elevated risk."],
    failureCategories: ["migration", "data-integrity", "transaction", "query", "indexing"],
    escalationRules: ["Block destructive or irreversible changes without an explicit operator-approved migration strategy."],
  },
  security: {
    id: "security.assurance", version: 1, label: "Security Engineering", discipline: "security",
    instructions: roleInstructions(
      ["Create a bounded threat model covering assets, actors, entry points, trust boundaries, abuse cases, and required controls."],
      ["Default deny, validate untrusted input, preserve secret boundaries, and add negative tests for the evidenced threat paths."],
      ["Run the full profile and independently verify authorization, input handling, secret exposure, dependency impact, and fail-closed behavior."],
      ["Review exploitability and evidence for authentication, authorization, injection, disclosure, cryptography, and supply-chain risks."],
    ),
    toolCapabilities: commonTools,
    requiredEvidence: ["A bounded threat model is recorded.", "Negative-path security tests exist.", "The full deterministic profile passes.", "The final Git diff is inspected."],
    verificationProfile: "full", requiresBrowserEvidence: false, minimumRisk: "R3",
    riskRules: ["Security-boundary changes are at least R3 and require explicit evidence rather than model confidence."],
    failureCategories: ["authentication", "authorization", "injection", "data-exposure", "cryptography", "supply-chain"],
    escalationRules: ["Block unresolved high or critical security findings and any unverified privilege-boundary change."],
  },
  qa: {
    id: "qa.verification", version: 1, label: "Quality Engineering", discipline: "qa",
    instructions: roleInstructions(
      ["Translate requirements into deterministic acceptance cases, failure cases, regression boundaries, and observable evidence."],
      ["Add focused tests without weakening assertions or changing production behavior merely to satisfy the suite."],
      ["Run the full profile, distinguish product failures from test defects, and preserve reproducible evidence."],
      ["Review coverage quality, assertion strength, determinism, boundary cases, and missing regression protection."],
    ),
    toolCapabilities: browserTools,
    requiredEvidence: ["The full deterministic profile passes.", "New or changed behavior has regression coverage.", "The final Git diff is inspected."],
    verificationProfile: "full", requiresBrowserEvidence: false, minimumRisk: "R1",
    riskRules: ["Escalate flaky, nondeterministic, skipped, or weakened verification."],
    failureCategories: ["coverage", "assertion", "flakiness", "fixture", "regression"],
    escalationRules: ["Block when acceptance criteria cannot be mapped to repeatable evidence."],
  },
  devops: {
    id: "devops.delivery", version: 1, label: "DevOps Engineering", discipline: "devops",
    instructions: roleInstructions(
      ["Map build, CI, release, deployment, secret, artifact, rollback, and environment boundaries."],
      ["Keep workflows deterministic, least-privileged, pinned where practical, and compatible with local verification."],
      ["Run the full profile and inspect workflow syntax, build artifacts, environment assumptions, secret handling, and rollback paths."],
      ["Review reproducibility, permissions, supply-chain exposure, deployment safety, and operational rollback."],
    ),
    toolCapabilities: commonTools,
    requiredEvidence: ["The full deterministic profile passes.", "Build or workflow changes are validated.", "Rollback and secret-handling implications are recorded.", "The final Git diff is inspected."],
    verificationProfile: "full", requiresBrowserEvidence: false, minimumRisk: "R2",
    riskRules: ["Escalate production deployment, credential, permission, and irreversible release changes."],
    failureCategories: ["build", "pipeline", "deployment", "artifact", "secret", "rollback"],
    escalationRules: ["Block deployment changes without reproducible validation and a viable rollback path."],
  },
  infrastructure: {
    id: "infrastructure.platform", version: 1, label: "Infrastructure Engineering", discipline: "infrastructure",
    instructions: roleInstructions(
      ["Map resources, network boundaries, identities, state, blast radius, cost, drift, and recovery expectations."],
      ["Prefer declarative, least-privileged, reviewable changes with explicit state and rollback implications."],
      ["Run the full profile and inspect plans, configuration syntax, privilege changes, state transitions, and recovery evidence."],
      ["Review blast radius, least privilege, network exposure, state safety, drift, capacity, and rollback."],
    ),
    toolCapabilities: commonTools,
    requiredEvidence: ["The full deterministic profile passes.", "Blast radius and rollback are documented.", "Privilege and network changes are explicitly reviewed.", "The final Git diff is inspected."],
    verificationProfile: "full", requiresBrowserEvidence: false, minimumRisk: "R3",
    riskRules: ["Infrastructure and privilege-boundary changes are at least R3."],
    failureCategories: ["network", "identity", "state", "capacity", "drift", "recovery"],
    escalationRules: ["Block high-blast-radius or privilege changes without operator-visible plan and recovery evidence."],
  },
};

const capabilityMap: Record<EngineeringRole, readonly string[]> = {
  architect: ["repository_*", "web_search", "web_fetch"],
  implementer: ["repository_*", "worktree_read", "worktree_patch", "worktree_command", "git_status", "git_diff", "browser_*"],
  verifier: ["worktree_read", "git_status", "git_diff", "verification_*", "browser_*"],
  reviewer: [],
};

const riskRank: Record<RiskLevel, number> = { R0: 0, R1: 1, R2: 2, R3: 3, R4: 4 };

function isInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

function matchesCapability(tool: string, capability: string): boolean {
  return capability.endsWith("*") ? tool.startsWith(capability.slice(0, -1)) : tool === capability;
}

export function roleAllowsTool(role: EngineeringRole, tool: string): boolean {
  return capabilityMap[role].some((capability) => matchesCapability(tool, capability));
}

export function roleCapabilities(role: EngineeringRole): readonly string[] {
  return capabilityMap[role];
}

export function getSpecialistPack(discipline: EngineeringDiscipline): SpecialistCapabilityPack {
  return specialistPacks[discipline];
}

export function selectSpecialistPacks(disciplines: readonly EngineeringDiscipline[]): SpecialistCapabilityPack[] {
  const selected = [...new Set(disciplines)].slice(0, 6);
  if (!selected.length) selected.push("general");
  return selected.map((discipline) => getSpecialistPack(discipline));
}

export function specialistPackRefs(packs: readonly SpecialistCapabilityPack[]): SpecialistPackRef[] {
  return packs.map(({ id, version, discipline }) => ({ id, version, discipline }));
}

export function specialistAllowsTool(disciplines: readonly EngineeringDiscipline[], tool: string): boolean {
  return selectSpecialistPacks(disciplines).some((pack) => pack.toolCapabilities.some((capability) => matchesCapability(tool, capability)));
}

export function specialistSystemInstructions(packs: readonly SpecialistCapabilityPack[], role: EngineeringRole): string {
  return packs.map((pack) => [
    `[${pack.label} · ${pack.id}@${pack.version}]`,
    ...pack.instructions[role].map((instruction) => `- ${instruction}`),
    `Required evidence: ${pack.requiredEvidence.join(" ")}`,
    `Risk rules: ${pack.riskRules.join(" ")}`,
    `Failure taxonomy: ${pack.failureCategories.join(", ")}.`,
    `Escalation: ${pack.escalationRules.join(" ")}`,
  ].join("\n")).join("\n\n");
}

export function verificationProfileFor(packs: readonly SpecialistCapabilityPack[]): "quick" | "full" {
  return packs.some((pack) => pack.verificationProfile === "full") ? "full" : "quick";
}

export function minimumRiskFor(packs: readonly SpecialistCapabilityPack[]): RiskLevel {
  return packs.reduce<RiskLevel>((highest, pack) => riskRank[pack.minimumRisk] > riskRank[highest] ? pack.minimumRisk : highest, "R1");
}

export function evaluateSpecialistEvidence(
  packs: readonly SpecialistCapabilityPack[],
  evidence: { browserEvidence?: { passed?: boolean } | null },
): SpecialistEvidenceResult {
  const requirements = [...new Set(packs.flatMap((pack) => pack.requiredEvidence))];
  const failures: string[] = [];
  for (const pack of packs) {
    if (pack.requiresBrowserEvidence && !evidence.browserEvidence) failures.push(`${pack.label} requires browser evidence, but none was captured.`);
    if (pack.requiresBrowserEvidence && evidence.browserEvidence && evidence.browserEvidence.passed === false) failures.push(`${pack.label} browser evidence did not pass.`);
  }
  return { passed: failures.length === 0, requirements, failures };
}

export class DisciplineRouter {
  route(request: string, changedFiles: readonly string[] = [], fallback: EngineeringDiscipline = "general"): DisciplineRoute {
    const found = new Set<EngineeringDiscipline>();
    const reasons: string[] = [];
    for (const signal of signals) {
      if (!signal.pattern.test(request)) continue;
      found.add(signal.discipline);
      reasons.push(signal.reason);
    }
    for (const file of changedFiles) {
      for (const signal of extensionSignals) {
        if (!signal.pattern.test(file)) continue;
        found.add(signal.discipline);
        reasons.push(`${signal.discipline} files changed`);
      }
    }
    const disciplines = [...found];
    if (!disciplines.length) disciplines.push(fallback);
    const primary = disciplines[0];
    return { primary, disciplines: disciplines.slice(0, 6), reasons: [...new Set(reasons)] };
  }
}

export class TeamPolicyService {
  load(repositoryPath: string | null | undefined): TeamPolicy {
    if (!repositoryPath) return TeamPolicySchema.parse({ version: 1 });
    const root = realpathSync(resolve(repositoryPath));
    const configuredPath = resolve(root, ".localcode", "team.json");
    if (!isInside(root, configuredPath) || !existsSync(configuredPath)) return TeamPolicySchema.parse({ version: 1 });
    const path = realpathSync(configuredPath);
    if (!isInside(root, path) || !lstatSync(path).isFile() || statSync(path).size > 100_000) throw new Error("Team policy is not a bounded repository file.");
    return TeamPolicySchema.parse(JSON.parse(readFileSync(path, "utf8")));
  }

  modelFor(policy: TeamPolicy, role: EngineeringRole, fallback: string, discipline?: EngineeringDiscipline): string {
    return (discipline ? policy.disciplines[discipline]?.model : null) ?? policy.roles[role].model ?? fallback;
  }
}

export function assertEngineeringRole(value: unknown): EngineeringRole {
  return z.enum(engineeringRoles).parse(value);
}
