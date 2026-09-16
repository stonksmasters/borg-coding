import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AccessController } from "../packages/repository/src/access-controller.ts";
import { ToolBroker } from "../packages/tools/src/tool-broker.ts";

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "borg-language-tools-"));
  const repository = join(root, "repo");
  mkdirSync(repository, { recursive: true });
  writeFileSync(join(repository, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler" } }));
  writeFileSync(join(repository, "model.ts"), [
    "export interface Greeter { greet(name: string): string }",
    "export function greet(name: string): string { return `Hello ${name}`; }",
    "export class FriendlyGreeter implements Greeter { greet(name: string) { return greet(name); } }",
    "",
  ].join("\n"));
  writeFileSync(join(repository, "use.ts"), [
    'import { greet } from "./model";',
    "const message = greet(42);",
    "console.log(message);",
    "",
  ].join("\n"));
  writeFileSync(join(repository, "secret-helper.ts"), "export const hiddenSecretSymbol = 42;\n");

  const access = new AccessController(join(root, "access.json"));
  access.save({ repositoryPath: repository, documents: [] });
  const broker = new ToolBroker(join(root, "tools.json"), access);
  return { broker };
}

test("canonical broker exposes TypeScript symbol navigation", async () => {
  const { broker } = createFixture();
  const names = broker.toolDefinitions("plan").map((definition) => definition.function.name);
  assert.ok(names.includes("repository_symbols"));
  assert.ok(names.includes("repository_definition"));
  assert.ok(names.includes("repository_diagnostics"));

  const symbols = await broker.execute({ function: { name: "repository_symbols", arguments: { query: "greet" } } }, "plan") as { symbols: { name: string; path: string }[] };
  assert.ok(symbols.symbols.some((item) => item.name === "greet" && item.path === "model.ts"));

  const definition = await broker.execute({ function: { name: "repository_definition", arguments: { path: "use.ts", line: 2, column: 17 } } }, "plan") as { locations: { path: string }[] };
  assert.ok(definition.locations.some((item) => item.path === "model.ts"));

  const diagnostics = await broker.execute({ function: { name: "repository_diagnostics", arguments: { path: "use.ts" } } }, "plan") as { diagnostics: { category: string; message: string }[] };
  assert.ok(diagnostics.diagnostics.some((item) => item.category === "error" && item.message.includes("number")));
});

test("language intelligence cannot cross the repository access policy", async () => {
  const { broker } = createFixture();
  const symbols = await broker.execute({ function: { name: "repository_symbols", arguments: { query: "hiddenSecretSymbol" } } }, "plan") as { symbols: { name: string }[] };
  assert.equal(symbols.symbols.length, 0);

  await assert.rejects(
    () => broker.execute({ function: { name: "repository_file_symbols", arguments: { path: "secret-helper.ts" } } }, "plan"),
    /access is not allowed/i,
  );
});
