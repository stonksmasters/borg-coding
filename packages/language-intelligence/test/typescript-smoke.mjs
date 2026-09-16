import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TypeScriptLanguageIntelligence } from "../dist/index.js";

const root = await mkdtemp(join(tmpdir(), "borg-language-"));
try {
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler" } }));
  const model = `export interface Greeter { greet(name: string): string }\nexport function greet(name: string): string { return \`Hello ${"${name}"}\`; }\nexport class FriendlyGreeter implements Greeter { greet(name: string) { return greet(name); } }\n`;
  const use = `import { greet } from "./model";\nconst message = greet(42);\nconsole.log(message);\n`;
  await writeFile(join(root, "model.ts"), model);
  await writeFile(join(root, "use.ts"), use);

  const intelligence = new TypeScriptLanguageIntelligence(root);
  const symbols = await intelligence.symbols("greet");
  assert(symbols.some((item) => item.name === "greet" && item.path === "model.ts"), "symbol search should find greet");

  const positionOf = (text, needle) => {
    const offset = text.indexOf(needle);
    const before = text.slice(0, offset);
    const lines = before.split("\n");
    return { line: lines.length, column: lines.at(-1).length + 1 };
  };
  const call = positionOf(use, "greet(42)");
  const definitions = await intelligence.definitions("use.ts", call.line, call.column);
  assert(definitions.some((item) => item.path === "model.ts"), "definition should resolve across files");

  const references = await intelligence.references("use.ts", call.line, call.column);
  assert(references.length >= 2, "references should include declaration/import/use locations");

  const fileSymbols = await intelligence.fileSymbols("model.ts");
  assert(fileSymbols.some((item) => item.name === "FriendlyGreeter"), "file symbols should expose classes");

  const info = await intelligence.quickInfo("use.ts", call.line, call.column);
  assert(info?.display.includes("greet"), "quick info should describe the symbol");

  const diagnostics = await intelligence.diagnostics("use.ts");
  assert(diagnostics.some((item) => item.category === "error" && item.message.includes("number")), "semantic diagnostics should catch the bad argument");

  console.log("TypeScript language intelligence smoke test passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
