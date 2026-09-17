import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

function definition(id: "python" | "rust" | "go" | "csharp") {
  return languageServerDefinitions.find((provider) => provider.id === id)!;
}

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

  const hierarchy = await provider.callHierarchy("sample.py", 1, 7);
  assert.equal(hierarchy.symbol?.name, "Example");
  assert.deepEqual(hierarchy.incoming.map((item) => item.symbol.name), ["caller"]);
  assert.deepEqual(hierarchy.outgoing.map((item) => item.symbol.name), ["callee"]);
  assert.equal(hierarchy.incoming[0]?.callSites[0]?.path, "sample.py");
});


test("polyglot graphs resolve Python, Rust, Go, and C# workspace dependencies", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "borg-polyglot-graphs-"));
  mkdirSync(join(root, "python"), { recursive: true });
  writeFileSync(join(root, "python", "model.py"), "def greet():\n    return 'hello'\n");
  writeFileSync(join(root, "python", "use.py"), "from .model import greet\ngreet()\n");
  writeFileSync(join(root, "python", "entry.py"), "from . import use\n");

  mkdirSync(join(root, "rust", "src"), { recursive: true });
  writeFileSync(join(root, "rust", "src", "model.rs"), "pub fn greet() {}\n");
  writeFileSync(join(root, "rust", "src", "use_model.rs"), "use crate::model::greet;\npub fn run() { greet(); }\n");

  mkdirSync(join(root, "go", "pkg"), { recursive: true });
  mkdirSync(join(root, "go", "use"), { recursive: true });
  writeFileSync(join(root, "go.mod"), "module example.test/project\n");
  writeFileSync(join(root, "go", "pkg", "model.go"), "package pkg\nfunc Greet() {}\n");
  writeFileSync(join(root, "go", "use", "use.go"), "package use\nimport \"example.test/project/go/pkg\"\nfunc Run() { pkg.Greet() }\n");

  mkdirSync(join(root, "csharp"), { recursive: true });
  writeFileSync(join(root, "csharp", "Model.cs"), "namespace App.Model;\npublic class Model {}\n");
  writeFileSync(join(root, "csharp", "Use.cs"), "using App.Model;\nnamespace App.Use;\npublic class Use { Model value = new(); }\n");
  writeFileSync(join(root, "csharp", "Entry.cs"), "using App.Use;\nnamespace App.Entry;\npublic class Entry { Use value = new(); }\n");

  const providers = (["python", "rust", "go", "csharp"] as const).map((id) => new LspLanguageIntelligence(root, {
    definition: definition(id),
    command: process.execPath,
    args: [fakeServer],
    timeoutMs: 2_000,
  }));
  const intelligence = new PolyglotLanguageIntelligence(root, {}, providers);
  t.after(() => intelligence.close());

  assert.deepEqual((await intelligence.fileGraph("python/model.py")).importedBy, ["python/use.py"]);
  const pythonImpact = await intelligence.changeImpact("python/model.py");
  assert.deepEqual(pythonImpact.directDependents, ["python/use.py"]);
  assert.deepEqual(pythonImpact.transitiveDependents, ["python/entry.py"]);

  assert.deepEqual((await intelligence.fileGraph("rust/src/use_model.rs")).imports, ["rust/src/model.rs"]);
  assert.deepEqual((await intelligence.fileGraph("go/use/use.go")).imports, ["go/pkg/model.go"]);
  assert.deepEqual((await intelligence.fileGraph("csharp/Model.cs")).importedBy, ["csharp/Use.cs"]);
  const csharpImpact = await intelligence.changeImpact("csharp/Model.cs");
  assert.deepEqual(csharpImpact.transitiveDependents, ["csharp/Entry.cs"]);
});

test("polyglot graph indexing preserves repository access boundaries", async () => {
  const root = mkdtempSync(join(tmpdir(), "borg-polyglot-access-"));
  writeFileSync(join(root, "allowed.py"), "import secret\n");
  writeFileSync(join(root, "secret.py"), "value = 1\n");
  const provider = new LspLanguageIntelligence(root, {
    definition: python,
    command: process.execPath,
    args: [fakeServer],
    allowPath: (path) => path !== "secret.py",
  });
  const intelligence = new PolyglotLanguageIntelligence(root, {}, [provider]);
  assert.deepEqual((await intelligence.fileGraph("allowed.py")).imports, []);
  await assert.rejects(() => intelligence.fileGraph("secret.py"), /access is not allowed/i);
  await intelligence.close();
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
