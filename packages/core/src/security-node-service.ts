import {
  ExecutionCapabilitySchema,
  ExecutionNodeSchema,
  type ExecutionCapability,
  type ExecutionNode,
} from "./security-domain.ts";
import {
  createExecutionRequest,
  type ExecutionProvider,
} from "./execution-provider.ts";
import { defaultSecurityToolRegistry } from "./security-tool-registry.ts";

export type CapabilityDefinition = {
  id: string;
  executable: string;
  category: ExecutionCapability["category"];
  versionArgs: string[];
};

export const defaultSecurityCapabilities: readonly CapabilityDefinition[] = [
  ...defaultSecurityToolRegistry.map((definition) => ({
    id: definition.id,
    executable: definition.executable,
    category: ["dns", "network", "web", "osint", "utility"].includes(definition.category)
      ? definition.category as ExecutionCapability["category"]
      : "utility" as const,
    versionArgs: [...definition.versionArgs],
  })),
] as const;

function firstLine(value: string): string | null {
  const line = value.split(/\r?\n/).map((part) => part.trim()).find(Boolean);
  return line ?? null;
}

export async function discoverExecutionCapabilities(
  node: ExecutionNode,
  provider: ExecutionProvider,
  definitions: readonly CapabilityDefinition[] = defaultSecurityCapabilities,
): Promise<ExecutionCapability[]> {
  const capabilities: ExecutionCapability[] = [];

  for (const definition of definitions) {
    try {
      const located = await provider.execute(node, createExecutionRequest({
        nodeId: node.id,
        executable: "which",
        args: [definition.executable],
        timeoutMs: 20_000,
      }));

      if (located.exitCode !== 0) {
        capabilities.push(ExecutionCapabilitySchema.parse({
          ...definition,
          status: "missing",
          version: null,
          detail: firstLine(located.stderr),
          checkedAt: new Date().toISOString(),
        }));
        continue;
      }

      const version = await provider.execute(node, createExecutionRequest({
        nodeId: node.id,
        executable: definition.executable,
        args: definition.versionArgs,
        timeoutMs: 20_000,
      }));

      capabilities.push(ExecutionCapabilitySchema.parse({
        id: definition.id,
        executable: definition.executable,
        category: definition.category,
        status: "available",
        version: firstLine(version.stdout) ?? firstLine(version.stderr),
        detail: version.exitCode === 0 ? null : `Version probe exited with ${version.exitCode ?? "no code"}.`,
        checkedAt: new Date().toISOString(),
      }));
    } catch (error) {
      capabilities.push(ExecutionCapabilitySchema.parse({
        id: definition.id,
        executable: definition.executable,
        category: definition.category,
        status: "error",
        version: null,
        detail: error instanceof Error ? error.message : "Capability probe failed.",
        checkedAt: new Date().toISOString(),
      }));
    }
  }

  return capabilities;
}

export async function refreshExecutionNode(
  nodeInput: ExecutionNode,
  provider: ExecutionProvider,
  definitions: readonly CapabilityDefinition[] = defaultSecurityCapabilities,
): Promise<ExecutionNode> {
  const node = ExecutionNodeSchema.parse(nodeInput);
  const now = new Date().toISOString();

  try {
    const health = await provider.healthCheck(node);
    const capabilities = await discoverExecutionCapabilities(node, provider, definitions);
    return ExecutionNodeSchema.parse({
      ...node,
      status: "online",
      platform: health.platform,
      architecture: health.architecture,
      capabilities,
      lastSeenAt: now,
      lastError: null,
      updatedAt: now,
    });
  } catch (error) {
    return ExecutionNodeSchema.parse({
      ...node,
      status: "error",
      capabilities: [],
      lastSeenAt: null,
      lastError: error instanceof Error ? error.message : "Execution node health check failed.",
      updatedAt: now,
    });
  }
}
