import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { engineeringDisciplines, engineeringRoles, type EngineeringDiscipline, type EngineeringRole } from "../../core/src/contracts.ts";

const RolePolicySchema = z.object({
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
}).strict();

export type TeamPolicy = z.infer<typeof TeamPolicySchema>;

export interface DisciplineRoute {
  primary: EngineeringDiscipline;
  disciplines: EngineeringDiscipline[];
  reasons: string[];
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

const capabilityMap: Record<EngineeringRole, readonly string[]> = {
  architect: ["repository_*", "web_search", "web_fetch"],
  implementer: ["repository_*", "worktree_read", "worktree_patch", "worktree_command", "git_status", "git_diff", "browser_*"],
  verifier: ["worktree_read", "git_status", "git_diff", "verification_*", "browser_*"],
  reviewer: [],
};

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

  modelFor(policy: TeamPolicy, role: EngineeringRole, fallback: string): string {
    return policy.roles[role].model ?? fallback;
  }
}

export function assertEngineeringRole(value: unknown): EngineeringRole {
  return z.enum(engineeringRoles).parse(value);
}
