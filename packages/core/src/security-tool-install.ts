import { z } from "zod";
import type { ExecutionNode } from "./security-domain.ts";

const aptPackages: Record<string, string> = {
  mcp_kali_server: "mcp-kali-server",
  dig: "bind9-dnsutils",
  nmap: "nmap",
  whois: "whois",
  dnsrecon: "dnsrecon",
  theharvester: "theharvester",
  sherlock: "sherlock",
  whatweb: "whatweb",
  gobuster: "gobuster",
};

export const SecurityInstallPlanSchema = z.object({
  nodeId: z.string().min(1),
  toolIds: z.array(z.string().min(1)),
  aptPackages: z.array(z.string().min(1)),
  manualTools: z.array(z.object({
    toolId: z.string().min(1),
    reason: z.string().min(1),
  })),
  commandPreview: z.array(z.string()),
  requiresAdministrativeApproval: z.literal(true),
  createdAt: z.string().datetime(),
});
export type SecurityInstallPlan = z.infer<typeof SecurityInstallPlanSchema>;

export function createSecurityInstallPlan(node: ExecutionNode, requestedToolIds: string[]): SecurityInstallPlan {
  const toolIds = [...new Set(requestedToolIds.map((value) => value.trim()).filter(Boolean))];
  const missing = new Set(node.capabilities.filter((capability) => capability.status !== "available").map((capability) => capability.id));
  const selected = toolIds.filter((toolId) => toolId === "mcp_kali_server" || missing.has(toolId));
  const packages = [...new Set(selected.flatMap((toolId) => aptPackages[toolId] ? [aptPackages[toolId]] : []))].sort();
  const manualTools = selected
    .filter((toolId) => !aptPackages[toolId])
    .map((toolId) => ({
      toolId,
      reason: toolId === "phoneinfoga"
        ? "PhoneInfoga requires a separately pinned architecture-specific release and checksum."
        : "No reviewed Kali package recipe is registered for this tool.",
    }));
  return SecurityInstallPlanSchema.parse({
    nodeId: node.id,
    toolIds: selected,
    aptPackages: packages,
    manualTools,
    commandPreview: packages.length ? [`sudo -n apt-get install --yes ${packages.join(" ")}`] : [],
    requiresAdministrativeApproval: true,
    createdAt: new Date().toISOString(),
  });
}

export function installCommand(plan: SecurityInstallPlan): { executable: string; args: string[] } | null {
  const value = SecurityInstallPlanSchema.parse(plan);
  if (!value.aptPackages.length) return null;
  return { executable: "sudo", args: ["-n", "apt-get", "install", "--yes", ...value.aptPackages] };
}
