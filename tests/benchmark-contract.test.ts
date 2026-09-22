import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ZodError } from "zod";
import {
  FrontendAutonomyBenchmarkSchema,
  parseFrontendAutonomyBenchmark,
} from "../packages/benchmark/src/contracts.ts";
import {
  BenchmarkFailureSchema,
  BenchmarkRunResultSchema,
} from "../packages/benchmark/src/result.ts";

function northlineFixture() {
  const path = join(process.cwd(), "benchmarks", "frontend-autonomy", "northline-v1", "benchmark.json");
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

test("northline frontend-autonomy benchmark fixture validates", () => {
  const parsed = parseFrontendAutonomyBenchmark(northlineFixture());
  assert.equal(parsed.id, "northline-v1");
  assert.equal(parsed.kind, "frontend-autonomy");
  assert.equal(parsed.expected.frontendOnly, true);
  assert.deepEqual(parsed.expected.requiredRoutes, ["/", "/work", "/services", "/about", "/contact"]);
  assert.equal(parsed.expected.minimumPages, 5);
  assert.equal(parsed.expected.requireFrontendComplete, true);
  assert.equal(parsed.limits.maxProjectPlanRevisions, 1);
});

test("northline fixture points at the preserved progressive-planning prompt", () => {
  const fixture = parseFrontendAutonomyBenchmark(northlineFixture());
  const promptPath = join(process.cwd(), "benchmarks", "frontend-autonomy", fixture.id, fixture.promptPath);
  const prompt = readFileSync(promptPath, "utf8");
  assert.match(prompt, /Northline Web/);
  assert.match(prompt, /Home[\s\S]*Work[\s\S]*Services[\s\S]*About[\s\S]*Contact/);
  assert.match(prompt, /Do not add login, dashboards, blogs, booking systems, careers, search, newsletters, or backend features/);
  assert.match(prompt, /detailed plan for the Home page only/);
});

test("benchmark contract rejects duplicate routes and impossible page minimums", () => {
  const fixture = northlineFixture() as Record<string, unknown>;
  const expected = fixture.expected as Record<string, unknown>;
  assert.throws(
    () => FrontendAutonomyBenchmarkSchema.parse({
      ...fixture,
      expected: {
        ...expected,
        requiredRoutes: ["/", "/work", "/work"],
        minimumPages: 4,
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ZodError);
      assert.match(error.issues.map((issue) => issue.message).join(" | "), /duplicates|minimumPages/i);
      return true;
    },
  );
});

test("benchmark contract rejects unsafe prompt paths before a run can start", () => {
  const fixture = northlineFixture() as Record<string, unknown>;
  assert.throws(
    () => FrontendAutonomyBenchmarkSchema.parse({ ...fixture, promptPath: "../outside.md" }),
    /promptPath/i,
  );
  assert.throws(
    () => FrontendAutonomyBenchmarkSchema.parse({ ...fixture, promptPath: "prompt.txt" }),
    /promptPath/i,
  );
});

test("benchmark result contract exposes stable status and failure categories", () => {
  const failure = BenchmarkFailureSchema.parse({
    code: "PROJECT_REPLANNED_DURING_SLICE_REPAIR",
    category: "repair",
    message: "A slice repair attempted to restart project planning.",
    taskId: "task-1",
    sliceId: "home",
  });
  assert.equal(failure.category, "repair");

  const result = BenchmarkRunResultSchema.parse({
    version: 1,
    benchmarkId: "northline-v1",
    status: "FAIL",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    failures: [failure],
  });
  assert.equal(result.status, "FAIL");
  assert.equal(result.failures[0]?.code, "PROJECT_REPLANNED_DURING_SLICE_REPAIR");
});

test("benchmark result contract rejects vague or malformed failure codes", () => {
  assert.throws(
    () => BenchmarkFailureSchema.parse({
      code: "benchmark failed",
      category: "workflow",
      message: "Too vague.",
      taskId: null,
      sliceId: null,
    }),
    /Failure codes/i,
  );
});
