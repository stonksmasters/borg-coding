import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const signalPath = resolve(process.env.BORG_SHUTDOWN_SIGNAL ?? ".borg/desktop/shutdown.signal");
const startedAt = Date.now();
let stopping = false;

const watcher = setInterval(() => {
  if (stopping || !existsSync(signalPath)) return;
  try {
    if (statSync(signalPath).mtimeMs <= startedAt) return;
    stopping = true;
    clearInterval(watcher);
    process.stderr.write(`[lifecycle] desktop shutdown signal observed by pid ${process.pid}\n`);
    process.kill(process.pid, "SIGTERM");
  } catch (error) {
    process.stderr.write(`[lifecycle] shutdown hook failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}, 250);
watcher.unref();
