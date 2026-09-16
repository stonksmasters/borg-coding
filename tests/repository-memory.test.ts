import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLanguageIntelligence } from "../packages/language-intelligence/src/index.ts";
import { AccessController } from "../packages/repository/src/access-controller.ts";
import { RepositoryMemory } from "../packages/repository/src/repository-memory.ts";
import { ToolBroker } from "../packages/tools/src/tool-broker.ts";

test("repository memory persists, refreshes changed files, and keeps provenance", async () => {
  const directory = mkdtempSync(join(tmpdir(), "borg-memory-"));
  const root = join(directory, "repo");
  mkdirSync(root);
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler" } }));
  writeFileSync(join(root, "model.ts"), "export function greet() { return 'hello'; }\n");
  writeFileSync(join(root, "use.ts"), "import { greet } from './model';\ngreet();\n");
  writeFileSync(join(root, "secret-helper.ts"), "export const secretSymbol = 1;\n");
  const access = new AccessController(join(directory, "access.json"));
  access.save({ repositoryPath: root });
  const database = join(directory, "memory.db");
  const memory = new RepositoryMemory(database);
  let reopened: RepositoryMemory | null = null;
  const language = createLanguageIntelligence(root, { allowPath: (path) => access.allowsRepositoryFile(path) });
  try {
    assert.deepEqual(await memory.refresh(access, language), { scanned: 2, updated: 2, removed: 0, truncated: false });
    assert.deepEqual(await memory.refresh(access, language), { scanned: 2, updated: 0, removed: 0, truncated: false });
    const broker = new ToolBroker(join(directory, "tools.json"), access, undefined, memory);
    assert.ok(broker.toolDefinitions("plan").some((item) => item.function.name === "repository_memory_search"));
    assert.ok(!broker.toolDefinitions("ask").some((item) => item.function.name === "repository_memory_search"));
    const result = await broker.execute({ function: { name: "repository_memory_search", arguments: { query: "greet" } } }, "plan") as { symbols: { path: string; name: string }[] };
    assert.ok(result.symbols.some((item) => item.path === "model.ts" && item.name === "greet"));
    assert.ok(memory.search(root, "model.ts").imports.some((item) => item.target === "model.ts"));
    assert.equal(memory.search(root, "secretSymbol").symbols.length, 0);
    assert.equal(memory.search(root, "greet", 20, () => false).symbols.length, 0);
    const otherRoot = join(directory, "other-repo");
    mkdirSync(otherRoot);
    assert.equal(memory.search(otherRoot, "greet").symbols.length, 0);
    memory.recordNote(root, { id: "finding:one", kind: "finding", text: "Check the greet contract", taskId: "task-1", path: "model.ts", line: 1, createdAt: new Date().toISOString() });
    memory.close();

    reopened = new RepositoryMemory(database);
    assert.equal(reopened.search(root, "contract").notes.length, 1);
    writeFileSync(join(root, "model.ts"), "export function welcome() { return 'hello'; }\n");
    assert.equal((await reopened.refresh(access, language)).updated, 1);
    assert.equal((reopened.search(root, "greet").symbols as { path: string }[]).filter((item) => item.path === "model.ts").length, 0);
    assert.ok(reopened.search(root, "welcome").symbols.length > 0);
    rmSync(join(root, "use.ts"));
    assert.equal((await reopened.refresh(access, language)).removed, 1);
    assert.equal(reopened.search(root, "use.ts").imports.length, 0);
  } finally {
    reopened?.close();
    try { memory.close(); } catch { /* already closed */ }
    await language.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
