import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ToolBroker } from "../packages/tools/src/tool-broker.ts";
import { AccessController } from "../packages/repository/src/access-controller.ts";

test("internet tools are disabled by default", async () => {
  const root = mkdtempSync(join(tmpdir(), "borg-tools-"));
  try {
    const broker = new ToolBroker(join(root, "tools.json"));
    assert.equal(broker.status().internetEnabled, false);
    await assert.rejects(() => broker.execute({ function: { name: "web_fetch", arguments: { url: "https://example.com" } } }), /disabled/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("web fetch blocks local network targets", async () => {
  const root = mkdtempSync(join(tmpdir(), "borg-tools-"));
  try {
    const broker = new ToolBroker(join(root, "tools.json"));
    broker.configure({ internetEnabled: true });
    await assert.rejects(() => broker.execute({ function: { name: "web_fetch", arguments: { url: "http://127.0.0.1:4311/health" } } }), /blocked/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("permission modes gate approved repository tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "borg-tools-"));
  try {
    const repository = join(root, "repo");
    mkdirSync(repository);
    writeFileSync(join(repository, "README.md"), "# Tool-visible repository");
    const access = new AccessController(join(root, "access.json"));
    access.save({ repositoryPath: repository });
    const broker = new ToolBroker(join(root, "tools.json"), access);

    assert.ok(!broker.toolDefinitions("ask").some((tool) => tool.function.name.startsWith("repository_")));
    assert.ok(broker.toolDefinitions("plan").some((tool) => tool.function.name === "repository_read"));
    await assert.rejects(() => broker.execute({ function: { name: "repository_read", arguments: { path: "README.md" } } }, "ask"), /ASK mode/);
    const result = await broker.execute({ function: { name: "repository_read", arguments: { path: "README.md" } } }, "plan") as { content: string };
    assert.match(result.content, /Tool-visible/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("specialist packs filter and enforce role-eligible tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "borg-specialist-tools-"));
  try {
    const broker = new ToolBroker(join(root, "tools.json"), undefined, {
      worktreeRoot: root,
      findApproval: () => null,
    });
    const context = { taskId: "task-specialist" };
    const backendTools = broker.toolDefinitions("agent", context, "implementer", ["backend"]);
    const frontendTools = broker.toolDefinitions("agent", context, "implementer", ["frontend"]);

    assert.equal(backendTools.some((tool) => tool.function.name === "worktree_patch"), true);
    assert.equal(backendTools.some((tool) => tool.function.name === "browser_capture"), false);
    assert.equal(frontendTools.some((tool) => tool.function.name === "browser_capture"), true);
    await assert.rejects(
      () => broker.execute({ function: { name: "browser_open", arguments: { url: "http://127.0.0.1:3000" } } }, "agent", context, "implementer", ["backend"]),
      /active specialist packs cannot invoke browser_open/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
