import assert from "node:assert/strict";
import test from "node:test";
import { createSecurityInstallPlan, installCommand } from "../packages/core/src/index.ts";
import { createExecutionNode } from "../packages/core/src/security-domain.ts";

test("guided Kali installation emits only reviewed package arguments", () => {
  const checkedAt = new Date().toISOString();
  const node = createExecutionNode({
    id: "kali",
    name: "Kali",
    provider: "ssh",
    host: "kali.local",
    username: "borg",
  });
  node.capabilities = [
    { id: "nmap", executable: "nmap", category: "network", status: "missing", version: null, detail: null, checkedAt },
    { id: "phoneinfoga", executable: "phoneinfoga", category: "osint", status: "missing", version: null, detail: null, checkedAt },
    { id: "maigret", executable: "maigret", category: "osint", status: "missing", version: null, detail: null, checkedAt },
    { id: "dig", executable: "dig", category: "dns", status: "missing", version: null, detail: null, checkedAt },
  ];

  const plan = createSecurityInstallPlan(node, ["nmap", "phoneinfoga", "maigret", "dig", "unknown-tool; reboot"]);
  assert.deepEqual(plan.aptPackages, ["bind9-dnsutils", "nmap"]);
  assert.deepEqual(plan.manualTools.map((value) => value.toolId), ["phoneinfoga", "maigret"]);
  assert.deepEqual(installCommand(plan), {
    executable: "sudo",
    args: ["-n", "apt-get", "install", "--yes", "bind9-dnsutils", "nmap"],
  });
});

test("guided Kali installation omits tools already available on the node", () => {
  const checkedAt = new Date().toISOString();
  const node = createExecutionNode({
    id: "kali",
    name: "Kali",
    provider: "ssh",
    host: "kali.local",
    username: "borg",
  });
  node.capabilities = [{ id: "nmap", executable: "nmap", category: "network", status: "available", version: "7.95", detail: null, checkedAt }];
  const plan = createSecurityInstallPlan(node, ["nmap"]);
  assert.deepEqual(plan.aptPackages, []);
  assert.equal(installCommand(plan), null);
});
