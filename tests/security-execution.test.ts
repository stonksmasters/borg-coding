import assert from "node:assert/strict";
import test from "node:test";
import {
  createExecutionNode,
  type ExecutionNode,
} from "../packages/core/src/security-domain.ts";
import {
  buildRemoteCommand,
  createExecutionRequest,
  quotePosixArgument,
  type ExecutionOptions,
  type ExecutionProvider,
  type ExecutionRequest,
  type ExecutionResult,
  type NodeHealth,
} from "../packages/core/src/execution-provider.ts";
import {
  discoverExecutionCapabilities,
  refreshExecutionNode,
  type CapabilityDefinition,
} from "../packages/core/src/security-node-service.ts";

class FakeExecutionProvider implements ExecutionProvider {
  readonly kind = "ssh" as const;

  constructor(
    private readonly available: Record<string, string>,
    private readonly healthError: Error | null = null,
  ) {}

  async healthCheck(_node: ExecutionNode, _options?: ExecutionOptions): Promise<NodeHealth> {
    if (this.healthError) throw this.healthError;
    return { online: true, platform: "Linux", architecture: "aarch64", latencyMs: 8 };
  }

  async execute(node: ExecutionNode, request: ExecutionRequest, _options?: ExecutionOptions): Promise<ExecutionResult> {
    let exitCode = 0;
    let stdout = "";
    let stderr = "";

    if (request.executable === "which") {
      const executable = request.args[0] ?? "";
      if (this.available[executable]) stdout = `/usr/bin/${executable}\n`;
      else exitCode = 1;
    } else if (this.available[request.executable]) {
      stdout = `${this.available[request.executable]}\n`;
    } else {
      exitCode = 127;
      stderr = "not found";
    }

    const now = new Date().toISOString();
    return {
      requestId: request.id,
      nodeId: node.id,
      startedAt: now,
      finishedAt: now,
      exitCode,
      signal: null,
      timedOut: false,
      cancelled: false,
      stdout,
      stderr,
      stdoutTruncated: false,
      stderrTruncated: false,
    };
  }
}

test("remote command builder quotes arguments instead of interpolating shell syntax", () => {
  const request = createExecutionRequest({
    id: "request-1",
    nodeId: "kali-pi",
    executable: "printf",
    args: ["%s", "hello; touch /tmp/nope", "it's-safe"],
    cwd: "/home/borg/work dir",
  });

  assert.equal(
    buildRemoteCommand(request),
    "cd '/home/borg/work dir' && exec 'printf' '%s' 'hello; touch /tmp/nope' 'it'\"'\"'s-safe'",
  );
  assert.equal(quotePosixArgument("$(whoami)"), "'$(whoami)'");
  assert.throws(() => quotePosixArgument("line1\nline2"), /newline/i);
});

test("remote executable rejects shell fragments", () => {
  const request = createExecutionRequest({
    id: "request-bad",
    nodeId: "kali-pi",
    executable: "nmap;echo",
  });
  assert.throws(() => buildRemoteCommand(request), /unsupported characters/i);
});

test("capability discovery produces structured available and missing tool state", async () => {
  const node = createExecutionNode({
    id: "kali-pi",
    name: "Kali Pi",
    provider: "ssh",
    host: "192.168.4.42",
    username: "borg",
  });
  const definitions: CapabilityDefinition[] = [
    { id: "nmap", executable: "nmap", category: "network", versionArgs: ["--version"] },
    { id: "httpx", executable: "httpx", category: "web", versionArgs: ["-version"] },
  ];
  const provider = new FakeExecutionProvider({ nmap: "Nmap version 7.95" });

  const capabilities = await discoverExecutionCapabilities(node, provider, definitions);
  assert.equal(capabilities[0]?.id, "nmap");
  assert.equal(capabilities[0]?.status, "available");
  assert.equal(capabilities[0]?.version, "Nmap version 7.95");
  assert.equal(capabilities[1]?.id, "httpx");
  assert.equal(capabilities[1]?.status, "missing");
});

test("node refresh records platform, architecture and capability state", async () => {
  const node = createExecutionNode({
    id: "kali-pi",
    name: "Kali Pi",
    provider: "ssh",
    host: "kali-pi.local",
    username: "borg",
  });
  const refreshed = await refreshExecutionNode(
    node,
    new FakeExecutionProvider({ nmap: "Nmap version 7.95" }),
    [{ id: "nmap", executable: "nmap", category: "network", versionArgs: ["--version"] }],
  );

  assert.equal(refreshed.status, "online");
  assert.equal(refreshed.platform, "Linux");
  assert.equal(refreshed.architecture, "aarch64");
  assert.equal(refreshed.capabilities[0]?.status, "available");
  assert.ok(refreshed.lastSeenAt);
  assert.equal(refreshed.lastError, null);
});

test("node refresh fails closed when the SSH health check fails", async () => {
  const node = createExecutionNode({
    id: "kali-pi",
    name: "Kali Pi",
    provider: "ssh",
    host: "kali-pi.local",
    username: "borg",
  });
  const refreshed = await refreshExecutionNode(
    node,
    new FakeExecutionProvider({}, new Error("connection refused")),
    [],
  );

  assert.equal(refreshed.status, "error");
  assert.match(refreshed.lastError ?? "", /connection refused/i);
  assert.deepEqual(refreshed.capabilities, []);
});
