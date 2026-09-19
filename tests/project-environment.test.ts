import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryCredentialStore } from "../packages/tools/src/credential-store.ts";
import { ProjectEnvironmentStore } from "../packages/tools/src/project-environment.ts";

test("project environment keeps values out of metadata and scopes them by repository", () => {
  const root = mkdtempSync(join(tmpdir(), "borg-project-env-"));
  try {
    const path = join(root, "project-environment.json");
    const credentials = new MemoryCredentialStore();
    const store = new ProjectEnvironmentStore(path, credentials);
    const firstRepo = "C:\\Code\\first";
    const secondRepo = "C:\\Code\\second";

    assert.deepEqual(store.list(firstRepo), []);
    assert.deepEqual(store.set(firstRepo, "API_TOKEN", "secret value with spaces"), [{ name: "API_TOKEN", hasValue: true }]);
    assert.equal(readFileSync(path, "utf8").includes("secret value with spaces"), false);
    assert.deepEqual(store.values(firstRepo), { API_TOKEN: "secret value with spaces" });
    assert.deepEqual(store.values(secondRepo), {});

    store.set(firstRepo, "PUBLIC_URL", "http://127.0.0.1:5173");
    assert.deepEqual(store.list(firstRepo).map((item) => item.name), ["API_TOKEN", "PUBLIC_URL"]);
    assert.deepEqual(store.delete(firstRepo, "API_TOKEN"), [{ name: "PUBLIC_URL", hasValue: true }]);
    assert.deepEqual(store.values(firstRepo), { PUBLIC_URL: "http://127.0.0.1:5173" });
    assert.throws(() => store.set(firstRepo, "NOT-VALID", "value"), /valid environment variable name/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
