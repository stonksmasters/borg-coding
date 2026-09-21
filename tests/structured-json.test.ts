import assert from "node:assert/strict";
import test from "node:test";
import {
  parseStructuredJson,
  structuredJsonSyntaxRepairPrompt,
  taggedJsonBody,
} from "../packages/web-builder/src/structured-json.ts";

test("structured JSON repair inserts a missing comma between array elements", () => {
  const parsed = parseStructuredJson<{ items: string[] }>('{"items":["alpha" "beta","gamma"]}');
  assert.equal(parsed.source, "repaired");
  assert.deepEqual(parsed.value.items, ["alpha", "beta", "gamma"]);
  assert.match(parsed.repairSummary ?? "", /missing comma/i);
});

test("structured JSON repair fixes a missing comma deep in a large local-model artifact", () => {
  const values = Array.from({ length: 140 }, (_, index) => `criterion-${index}-${"x".repeat(28)}`);
  const valid = JSON.stringify({ acceptanceCriteria: values });
  const needle = `"${values[118]}","${values[119]}"`;
  const malformed = valid.replace(needle, `"${values[118]}" "${values[119]}"`);
  assert.ok(malformed.indexOf(values[119]) > 4_500);
  const parsed = parseStructuredJson<{ acceptanceCriteria: string[] }>(malformed);
  assert.equal(parsed.source, "repaired");
  assert.equal(parsed.value.acceptanceCriteria.length, values.length);
  assert.equal(parsed.value.acceptanceCriteria[119], values[119]);
  assert.match(parsed.repairSummary ?? "", /missing comma/i);
});

test("structured JSON repair inserts a missing comma between object properties", () => {
  const parsed = parseStructuredJson<{ first: number; second: number }>('{"first":1 "second":2}');
  assert.equal(parsed.source, "repaired");
  assert.deepEqual(parsed.value, { first: 1, second: 2 });
  assert.match(parsed.repairSummary ?? "", /missing comma/i);
});

test("structured JSON repair removes trailing commas and escapes raw newlines in strings", () => {
  const malformed = `{"title":"Field
Notes","items":["one","two",],}`;
  const parsed = parseStructuredJson<{ title: string; items: string[] }>(malformed);
  assert.equal(parsed.source, "repaired");
  assert.equal(parsed.value.title, "Field\nNotes");
  assert.deepEqual(parsed.value.items, ["one", "two"]);
  assert.match(parsed.repairSummary ?? "", /control characters|trailing commas/i);
});

test("structured JSON repair accepts fenced JSON and trims artifact noise", () => {
  const parsed = parseStructuredJson<{ ok: boolean }>('\`\`\`json\n{"ok":true}\n\`\`\`'.replaceAll("\\\`", "\`"));
  assert.equal(parsed.source, "repaired");
  assert.deepEqual(parsed.value, { ok: true });
});

test("syntax repair prompt preserves the malformed artifact instead of asking for regeneration", () => {
  const malformed = '<borg-product-map>{"features":["one" "two"]}</borg-product-map>';
  assert.equal(taggedJsonBody(malformed, "borg-product-map"), '{"features":["one" "two"]}');
  const prompt = structuredJsonSyntaxRepairPrompt({
    tag: "borg-product-map",
    parserError: "Expected ',' or ']' after array element at position 19",
    malformedArtifact: malformed,
  });
  assert.match(prompt, /Repair JSON syntax only/i);
  assert.match(prompt, /Preserve the existing product decisions/i);
  assert.match(prompt, /"one" "two"/);
  assert.match(prompt, /<borg-product-map>/);
});
