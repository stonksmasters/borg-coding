import assert from "node:assert/strict";
import test from "node:test";
import { splitNdjsonBuffer } from "../apps/server/src/ndjson-stream.ts";

test("NDJSON stream retains partial chunks and consumes a final event without newline", () => {
  assert.deepEqual(splitNdjsonBuffer('{"type":"task.created"', false), { lines: [], remainder: '{"type":"task.created"' });
  assert.deepEqual(splitNdjsonBuffer('{"type":"task.created"}\n{"type":"approval.requested"', false), {
    lines: ['{"type":"task.created"}'], remainder: '{"type":"approval.requested"',
  });
  assert.deepEqual(splitNdjsonBuffer('{"type":"approval.requested"}', true), {
    lines: ['{"type":"approval.requested"}'], remainder: "",
  });
  assert.deepEqual(splitNdjsonBuffer('{"type":"approval.requested"}\n', true), {
    lines: ['{"type":"approval.requested"}', ""], remainder: "",
  });
});
