import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateArchitectOutput } from "../apps/server/src/architect-output.ts";
import { createChatMessage, createChatSession, createModeEscalationRequest } from "../packages/core/src/chat-session.ts";
import { SqliteChatRepository } from "../packages/persistence/src/sqlite-chat-repository.ts";
import { MemoryCredentialStore } from "../packages/tools/src/credential-store.ts";
import { InternetConfigurationStore } from "../packages/tools/src/internet-configuration.ts";
import { ToolBroker } from "../packages/tools/src/tool-broker.ts";
import { parseMessage } from "../components/chat/message-parser.ts";

test("chat sessions, messages, selected mode, and pending escalation survive repository restart", () => {
  const root = mkdtempSync(join(tmpdir(), "borg-chat-session-"));
  const database = join(root, "borg.db");
  try {
    const first = new SqliteChatRepository(database);
    const session = createChatSession({ id: "session-1", title: "Persistent workstation", activeMode: "plan", repositoryPath: "C:\\Code\\borg", workspaceId: "borg-code" });
    first.saveSession(session);
    first.appendMessage(createChatMessage({ id: "message-1", sessionId: session.id, role: "user", text: "Inspect the mode bug." }));
    first.appendMessage(createChatMessage({ id: "message-2", sessionId: session.id, role: "assistant", kind: "plan", text: "I will trace the permission state." }));
    first.bindTask(session.id, "task-1");
    const escalation = createModeEscalationRequest({ id: "escalation-1", sessionId: session.id, taskId: "task-1", planText: "Inspect, then patch after approval." });
    first.saveModeEscalation(escalation);
    first.updateSession(session.id, { activeMode: "edit" });
    first.close();

    const second = new SqliteChatRepository(database);
    const restored = second.findSession(session.id);
    assert.ok(restored);
    assert.equal(restored.activeMode, "edit");
    assert.equal(restored.repositoryPath, "C:\\Code\\borg");
    assert.equal(second.listMessages(session.id).length, 2);
    assert.equal(second.listMessages(session.id)[1].kind, "plan");
    assert.equal(second.latestTaskId(session.id), "task-1");
    assert.deepEqual(second.findModeEscalation("task-1"), escalation);
    assert.deepEqual(second.latestModeEscalation(session.id), escalation);
    assert.equal(second.deleteModeEscalation("task-1"), true);
    assert.equal(second.findModeEscalation("task-1"), null);
    second.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("internet settings persist metadata while credentials remain outside config files", () => {
  const root = mkdtempSync(join(tmpdir(), "borg-internet-config-"));
  try {
    const path = join(root, "internet.json");
    const credentials = new MemoryCredentialStore();
    const store = new InternetConfigurationStore(path, credentials, "test-target");
    const saved = store.save({ internetEnabled: true, apiKey: "secret-api-key" });
    assert.equal(saved.internetEnabled, true);
    assert.equal(saved.credentialConfigured, true);
    assert.equal(saved.state, "configured");
    assert.equal(readFileSync(path, "utf8").includes("secret-api-key"), false);
    assert.equal(store.credential(), "secret-api-key");

    const available = store.markAvailable();
    assert.equal(available.state, "available");

    const restarted = new InternetConfigurationStore(path, credentials, "test-target");
    const reconstructed = restarted.load();
    assert.equal(reconstructed.internetEnabled, true);
    assert.equal(reconstructed.credentialConfigured, true);
    assert.equal(reconstructed.state, "available");
    assert.equal(restarted.credential(), "secret-api-key");

    restarted.save({ clearApiKey: true });
    assert.equal(restarted.load().credentialConfigured, false);
    assert.equal(restarted.credential(), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("PLAN exposes no mutation tools and rejects mutation while EDIT and AGENT can patch approved worktrees", async () => {
  const root = mkdtempSync(join(tmpdir(), "borg-mode-authority-"));
  try {
    const worktreeRoot = join(root, "worktrees");
    const approvedWorktree = join(worktreeRoot, "task-mode");
    mkdirSync(approvedWorktree, { recursive: true });
    const broker = new ToolBroker(join(root, "tools.json"), undefined, {
      worktreeRoot,
      findApproval: (taskId) => taskId === "task-mode" ? {
        taskId,
        status: "APPROVED",
        worktreePath: approvedWorktree,
        baseCommit: "0123456789abcdef",
      } : null,
    });
    const context = { taskId: "task-mode" };

    assert.equal(broker.toolDefinitions("plan", context).some((tool) => tool.function.name === "worktree_patch"), false);
    assert.equal(broker.toolDefinitions("edit", context).some((tool) => tool.function.name === "worktree_patch"), true);
    assert.equal(broker.toolDefinitions("agent", context).some((tool) => tool.function.name === "worktree_patch"), true);

    await assert.rejects(
      () => broker.execute({ function: { name: "worktree_patch", arguments: { path: "plan.txt", old_text: "", new_text: "should-not-exist" } } }, "plan", context),
      /require EDIT or AGENT mode/,
    );

    await broker.execute({ function: { name: "worktree_patch", arguments: { path: "edit.txt", old_text: "", new_text: "edit-authorized" } } }, "edit", context);
    await broker.execute({ function: { name: "worktree_patch", arguments: { path: "agent.txt", old_text: "", new_text: "agent-authorized" } } }, "agent", context);
    assert.equal(readFileSync(join(approvedWorktree, "edit.txt"), "utf8"), "edit-authorized");
    assert.equal(readFileSync(join(approvedWorktree, "agent.txt"), "utf8"), "agent-authorized");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("PLAN escalation is a structured transition request instead of mutation authorization", () => {
  const request = createModeEscalationRequest({ id: "escalation-1", sessionId: "session-1", taskId: "task-1", planText: "1. Inspect.\n2. Patch after approval." });
  assert.equal(request.fromMode, "plan");
  assert.equal(request.requestedMode, "edit");
  assert.match(request.reason, /mutation-capable/);
  assert.match(request.planText, /Patch after approval/);
});

test("architect phase rejects fabricated implementation and verification reports", () => {
  assert.deepEqual(validateArchitectOutput("Plan:\n1. Inspect the runtime.\n2. Patch after approval.\n3. Run tests."), { valid: true, reason: null });
  assert.equal(validateArchitectOutput("Implementation complete. I updated the server and tests passed.").valid, false);
  assert.equal(validateArchitectOutput("## Changes made:\n- Patched the gateway\n\nBrowser verification passed.").valid, false);
  assert.equal(validateArchitectOutput("I ran npm test and fixed the failing mode transition.").valid, false);
});

test("assistant message parser separates prose, terminal, source, diff, lists, and tables", () => {
  const blocks = parseMessage(`# Result\n\nNormal prose with \`src/app.ts\`.\n\n- first\n- second\n\n| File | Status |\n| --- | --- |\n| src/app.ts | changed |\n\n\`\`\`bash\nnpm test\n\`\`\`\n\n\`\`\`ts\nconst ready = true;\n\`\`\`\n\n\`\`\`diff\n-old\n+new\n\`\`\``);
  assert.deepEqual(blocks.map((block) => block.type), ["heading", "prose", "list", "table", "terminal", "code", "diff"]);
});
