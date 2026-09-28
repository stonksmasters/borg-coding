import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { frontendFoundationFiles } from "../packages/web-builder/src/frontend-foundation.ts";
import { defaultTheme, ThemeContractSchema, themeStylesheet, themeVariables } from "../packages/ui-catalog/src/theme.ts";

test("every generated foundation is self-contained TSX and has explicit pending evidence", () => {
  for (const template of ["portfolio", "ecommerce", "dashboard", "saas-landing", "waitlist"] as const) {
    const files = frontendFoundationFiles(template);
    for (const [path, source] of Object.entries(files).filter(([path]) => path.endsWith(".tsx"))) {
      const result = ts.transpileModule(source, { fileName: path, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true });
      assert.deepEqual(result.diagnostics, [], path);
      assert.doesNotMatch(source, /packages\/|@borg\//);
    }
    assert.equal(JSON.parse(files[".localcode/build/catalog.json"]).reviewStatus, "pending");
    assert.ok(files["src/borg/primitives.tsx"]);
  }
});

test("theme inputs reject CSS injection and numeric extremes before generating variables", () => {
  const theme = defaultTheme();
  assert.equal(themeVariables(theme)["--borg-accent"], "#235747");
  assert.match(themeStylesheet(theme), /\n}\n$/);
  assert.equal(ThemeContractSchema.safeParse({ ...theme, colors: { ...theme.colors, accent: "red; background: url(https://example.org)" } }).success, false);
  assert.equal(ThemeContractSchema.safeParse({ ...theme, spacing: 500 }).success, false);
});
