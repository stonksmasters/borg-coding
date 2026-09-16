import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepositoryTools } from "../packages/repository/dist/index.js";

function git(cwd, ...args) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

const root = await mkdtemp(join(tmpdir(), "borg-review-"));

try {
  git(root, "init");
  git(root, "config", "user.email", "borg@example.invalid");
  git(root, "config", "user.name", "BORG CI");

  const source = join(root, "app.txt");
  await writeFile(source, "one\ntwo\nthree\n", "utf8");
  git(root, "add", "app.txt");
  git(root, "commit", "-m", "base");

  // The user already has an uncommitted edit before BORG starts.
  await writeFile(source, "one\nUSER EDIT\nthree\n", "utf8");

  const repository = new RepositoryTools(root);
  await repository.captureTaskBaseline("reject-hunk");

  // BORG changes a different line. Rejecting it must preserve the user's edit.
  await writeFile(source, "one\nUSER EDIT\nBORG EDIT\n", "utf8");
  let review = await repository.getTaskReview("reject-hunk");
  assert.equal(review.files.length, 1);
  assert.equal(review.files[0]?.path, "app.txt");
  assert.equal(review.files[0]?.hunks.length, 1);

  const rejectHunk = review.files[0]?.hunks[0];
  assert.ok(rejectHunk);
  review = await repository.rejectReviewHunk("reject-hunk", "app.txt", rejectHunk.id);
  assert.equal(review.pendingFiles, 0);
  assert.equal(await readFile(source, "utf8"), "one\nUSER EDIT\nthree\n");

  // Accepting a hunk keeps it in the working tree and advances only BORG's review baseline.
  await repository.captureTaskBaseline("accept-hunk");
  await writeFile(source, "one\nUSER EDIT\nACCEPTED BORG EDIT\n", "utf8");
  review = await repository.getTaskReview("accept-hunk");
  const acceptHunk = review.files[0]?.hunks[0];
  assert.ok(acceptHunk);
  review = await repository.acceptReviewHunk("accept-hunk", "app.txt", acceptHunk.id);
  assert.equal(review.pendingFiles, 0);
  assert.equal(await readFile(source, "utf8"), "one\nUSER EDIT\nACCEPTED BORG EDIT\n");

  // A later change in the same task rejects back to the accepted state, not all the way to HEAD.
  await writeFile(source, "CHANGED AGAIN\nUSER EDIT\nACCEPTED BORG EDIT\n", "utf8");
  review = await repository.getTaskReview("accept-hunk");
  assert.equal(review.pendingFiles, 1);
  review = await repository.rejectAllReviewChanges("accept-hunk");
  assert.equal(review.pendingFiles, 0);
  assert.equal(await readFile(source, "utf8"), "one\nUSER EDIT\nACCEPTED BORG EDIT\n");

  // New files can be accepted without Git add/staging side effects.
  await repository.captureTaskBaseline("new-file");
  await writeFile(join(root, "new-file.txt"), "hello from BORG\n", "utf8");
  review = await repository.getTaskReview("new-file");
  assert.equal(review.files[0]?.kind, "added");
  review = await repository.acceptReviewFile("new-file", "new-file.txt");
  assert.equal(review.pendingFiles, 0);
  const status = gitStatus(root);
  assert.match(status, /\?\? new-file\.txt/);

  console.log("granular review smoke test passed");
} finally {
  await rm(root, { recursive: true, force: true });
}

function gitStatus(cwd) {
  return execFileSync("git", ["status", "--short", "--untracked-files=all"], { cwd, encoding: "utf8" });
}
