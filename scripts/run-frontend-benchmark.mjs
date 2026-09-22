import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  BorgBenchmarkClient,
  parseFrontendAutonomyBenchmark,
  runFrontendBenchmark,
} from "../packages/benchmark/src/index.ts";

const id = process.argv[2] || "northline-v1";
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
  throw new Error("Benchmark id must be a lowercase kebab-case identifier.");
}
const root = resolve(process.cwd(), "benchmarks", "frontend-autonomy", id);
const benchmark = parseFrontendAutonomyBenchmark(JSON.parse(await readFile(resolve(root, "benchmark.json"), "utf8")));
const prompt = await readFile(resolve(root, benchmark.promptPath), "utf8");
const baseUrl = process.env.BORG_GATEWAY_URL || "http://127.0.0.1:4312";

console.log(`BORG frontend autonomy benchmark: ${benchmark.name}`);
console.log(`Gateway: ${baseUrl}`);

const outcome = await runFrontendBenchmark({
  client: new BorgBenchmarkClient(baseUrl),
  benchmark,
  prompt,
  onObservation(observation) {
    const slice = observation.sliceTitle
      ? ` · ${observation.sliceTitle}`
      : "";
    const stage = observation.stage
      ? ` · ${observation.stage}`
      : "";
    console.log(`[${observation.at}] ${observation.taskState ?? "no-task"}${slice}${stage} · next=${observation.nextAction ?? "unknown"}`);
  },
});

console.log(`\nRESULT: ${outcome.result.status}`);
console.log(`Session: ${outcome.sessionId ?? "none"}`);
console.log(`Tasks observed: ${outcome.taskIds.length}`);
console.log(`Project plan approvals: ${outcome.approvals.projectPlan}`);
console.log(`Project plan revision approvals: ${outcome.approvals.projectPlanRevision}`);
for (const item of outcome.result.failures) {
  console.error(`- [${item.category}] ${item.code}: ${item.message}`);
}

if (outcome.result.status !== "PASS") process.exitCode = 1;
