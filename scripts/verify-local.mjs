import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

if (!process.env.npm_execpath) {
  throw new Error("Run verification through npm (for example: npm run verify:all).");
}

const args = new Set(process.argv.slice(2));
const coreOnly = args.has("--core-only");
const freshInstall = args.has("--fresh-install");
const skipDesktop = args.has("--skip-desktop");
const npmExec = process.env.npm_execpath;

const stages = [
  ...(freshInstall ? [{ id: "install", label: "Locked dependency install", script: "install:ci" }] : []),
  { id: "check", label: "TypeScript typecheck", script: "check" },
  { id: "lint", label: "ESLint", script: "lint" },
  { id: "test", label: "Node test suite", script: "test" },
  { id: "build", label: "Production web build", script: "build" },
];

if (!coreOnly && !skipDesktop) {
  if (process.platform === "win32") {
    stages.push({ id: "desktop", label: "Windows desktop lifecycle", script: "desktop:lifecycle-test" });
  } else {
    stages.push({ id: "desktop-skip", label: "Windows desktop lifecycle", script: null });
  }
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, milliseconds / 1000);
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(0)}s`;
}

function divider(char = "─") {
  return char.repeat(72);
}

function runScript(script) {
  const result = spawnSync(
    process.execPath,
    [npmExec, "run", script],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        BORG_LOCAL_VERIFY: "1",
      },
    },
  );
  if (result.error) throw result.error;
  return result.status ?? 1;
}

console.log("\nBORG local verification");
console.log(divider("═"));
console.log(`Mode: ${freshInstall ? "clean install + " : ""}${coreOnly ? "core" : "full"}`);
console.log(`Platform: ${process.platform} ${process.arch}`);
console.log(`Node: ${process.version}`);
if (!coreOnly && process.platform !== "win32" && !skipDesktop) {
  console.log("Desktop lifecycle: skipped (Windows-only test)");
}
console.log(divider());

const startedAt = performance.now();
const results = [];
let blocked = false;

for (const stage of stages) {
  if (stage.script === null) {
    results.push({ ...stage, status: "skipped", duration: 0 });
    continue;
  }

  if (blocked) {
    results.push({ ...stage, status: "blocked", duration: 0 });
    continue;
  }

  console.log(`\n▶ ${stage.label}  [npm run ${stage.script}]`);
  console.log(divider());

  const stageStartedAt = performance.now();
  let exitCode = 1;
  try {
    exitCode = runScript(stage.script);
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    exitCode = 1;
  }

  const duration = performance.now() - stageStartedAt;
  const status = exitCode === 0 ? "passed" : "failed";
  results.push({ ...stage, status, duration, exitCode });

  console.log(divider());
  console.log(`${status === "passed" ? "✓" : "✗"} ${stage.label} ${status} in ${formatDuration(duration)}`);

  // A failed clean install makes every later result meaningless. Core verification
  // otherwise continues so one local run can surface multiple independent failures.
  if (stage.id === "install" && exitCode !== 0) blocked = true;
}

const elapsed = performance.now() - startedAt;
const failed = results.filter((result) => result.status === "failed");
const skipped = results.filter((result) => result.status === "skipped");
const blockedStages = results.filter((result) => result.status === "blocked");

console.log("\n");
console.log(divider("═"));
console.log("BORG verification summary");
console.log(divider("═"));
for (const result of results) {
  const symbol = result.status === "passed" ? "✓"
    : result.status === "failed" ? "✗"
      : result.status === "skipped" ? "↷"
        : "·";
  const duration = result.duration ? ` (${formatDuration(result.duration)})` : "";
  console.log(`${symbol} ${result.label}: ${result.status}${duration}`);
}
console.log(divider());
console.log(`Total: ${formatDuration(elapsed)}`);

if (skipped.length) {
  console.log("\nNote: Windows desktop lifecycle tests can only run on Windows.");
}
if (blockedStages.length) {
  console.log("\nLater stages were blocked because the locked dependency install failed.");
}
if (failed.length) {
  console.error(`\nVerification failed in ${failed.length} stage${failed.length === 1 ? "" : "s"}: ${failed.map((stage) => stage.label).join(", ")}.`);
  process.exit(1);
}

console.log("\nAll runnable verification stages passed.");
