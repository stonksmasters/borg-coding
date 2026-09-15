import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AccessController } from "../packages/repository/src/access-controller.ts";

test("access context contains approved files and excludes secrets", () => {
  const root = mkdtempSync(join(tmpdir(), "borg-access-"));
  try {
    const repository = join(root, "sample-repo");
    mkdirSync(repository);
    writeFileSync(join(repository, "README.md"), "# Approved repository");
    writeFileSync(join(repository, ".env"), "TOKEN=must-not-leak");
    const note = join(root, "notes.txt");
    writeFileSync(note, "Approved supporting note");

    const controller = new AccessController(join(root, "access.json"));
    controller.save({ repositoryPath: repository, documents: [note] });
    const context = controller.buildContext();
    assert.match(context, /Approved repository/);
    assert.match(context, /Approved supporting note/);
    assert.doesNotMatch(context, /must-not-leak/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("access controller rejects sensitive explicit documents", () => {
  const root = mkdtempSync(join(tmpdir(), "borg-access-"));
  try {
    const secret = join(root, "credentials.txt");
    writeFileSync(secret, "secret");
    const controller = new AccessController(join(root, "access.json"));
    assert.throws(() => controller.save({ documents: [secret] }), /Sensitive file types/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("repository tools stay inside the approved root and omit excluded files", () => {
  const root = mkdtempSync(join(tmpdir(), "borg-access-"));
  try {
    const repository = join(root, "sample-repo");
    mkdirSync(join(repository, "src"), { recursive: true });
    mkdirSync(join(repository, "node_modules"));
    writeFileSync(join(repository, "src", "main.ts"), "export const answer = 42;\n");
    writeFileSync(join(repository, "node_modules", "hidden.js"), "do not scan");
    const controller = new AccessController(join(root, "access.json"));
    controller.save({ repositoryPath: repository });

    const listing = controller.listFiles({ depth: 3 });
    assert.ok(listing.entries.some((entry) => entry.path === "src/main.ts"));
    assert.ok(!listing.entries.some((entry) => entry.path.includes("node_modules")));
    assert.match(controller.readFile("src/main.ts").content, /answer = 42/);
    assert.deepEqual(controller.searchFiles("answer").matches.map((match) => [match.path, match.line]), [["src/main.ts", 1]]);
    assert.throws(() => controller.readFile("../outside.txt"), /outside/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
