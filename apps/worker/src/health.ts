import { existsSync, readFileSync, statSync } from "node:fs";

const HEALTH_FILE = process.env.WORKER_HEALTH_FILE ?? "/tmp/archive-worker-health";
const MAX_AGE_MS = 15_000;

function main() {
  if (!existsSync(HEALTH_FILE)) {
    console.error("worker health file missing");
    process.exit(1);
  }

  const age = Date.now() - statSync(HEALTH_FILE).mtimeMs;
  if (age > MAX_AGE_MS) {
    console.error(`worker health file stale: ${age}ms`);
    process.exit(1);
  }

  console.log(readFileSync(HEALTH_FILE, "utf8").trim());
}

main();
