import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PolyglotLanguageIntelligence } from "../packages/language-intelligence/src/index.ts";
import {
  LspLanguageIntelligence,
  languageServerDefinitions,
} from "../packages/language-intelligence/src/lsp-provider.ts";

const fakeServer = fileURLToPath(new URL("./fixtures/fake-lsp-server.mjs", import.meta.url));
const python = languageServerDefinitions.find((provider) => provider.id === "python")!;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "borg-polyglot-"));
  writeFileSync(join(root, "sample.py"), "class Example:\n    method = 1\n", "utf8");
  const provider = new LspLanguageIntelligence(root, {
    definition: python,
    command: process.execPath,
    args: [fakeServer],
    timeoutMs: 2_000,
  });
  return { root, provider };
}

test("LSP provider normalizes navigation, hover, and diagnostics", async (t) => {
  const { provider } = fixture();
  t.after(() => provider.close());

  assert.equal(provider.status().available, true);

  const symbols = await provider.symbols("inside");
  assert.deepEqual(symbols.map((item) => item.name), ["inside_symbol"]);
  assert.equal(symbols[0]?.path, "sample.py");

  const outline = await provider.fileSymbols("sample.py");
  assert.deepEqual(outline.map((item) => [item.name, item.depth]), [["Example", 1], ["method", 2]]);

  const definitions = await provider.definitions("sample.py", 1, 7);
  assert.equal(definitions.length, 1);
  assert.equal(definitions[0]?.path, "sample.py");
  assert.deepEqual(await provider.references("sample.py", 1, 7), [{
    path: "sample.py", line: 2, column: 5, endLine: 2, endColumn: 11,
  }]);
  assert.equal((await provider.implementations("sample.py", 1, 7))[0]?.line, 2);

  const hover = await provider.quickInfo("sample.py", 1, 7);
  assert.match(hover?.display ?? "", /fake hover/);

  const diagnostics = await provider.diagnostics("sample.py");
  assert.deepEqual(diagnostics, [{
    code: 7001,
    category: "warning",
    message: "Fake warning",
    path: "sample.py",
    line: 2,
    column: 5,
    endLine: 2,
    endColumn: 10,
  }]);
});

test("polyglot router exposes status and selects a provider by extension", async (t) => {
  const { root, provider } = fixture();
  const intelligence = new PolyglotLanguageIntelligence(root, {}, [provider]);
  t.after(() => intelligence.close());

  assert.equal(intelligence.supports("sample.py"), true);
  assert.equal(intelligence.status().find((item) => item.id === "typescript")?.available, true);
  assert.equal(intelligence.status().find((item) => item.id === "python")?.available, true);
  assert.equal((await intelligence.fileSymbols("sample.py"))[0]?.name, "Example");
});

test("disabled and missing language servers remain explicit", async () => {
  const root = mkdtempSync(join(tmpdir(), "borg-polyglot-disabled-"));
  writeFileSync(join(root, "sample.py"), "value = 1\n", "utf8");
  const provider = new LspLanguageIntelligence(root, {
    definition: python,
    enabled: false,
  });

  assert.equal(provider.status().enabled, false);
  assert.equal(provider.status().available, false);
  assert.match(provider.status().reason ?? "", /disabled/i);
  await assert.rejects(() => provider.fileSymbols("sample.py"), /disabled/i);
});
