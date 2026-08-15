import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@archive/core": resolve(__dirname, "packages/core/src/index.ts"),
      "@archive/config": resolve(__dirname, "packages/config/src/index.ts"),
      "@archive/worker/backfill": resolve(__dirname, "apps/worker/src/backfill.ts"),
      "@archive/worker/retention": resolve(__dirname, "apps/worker/src/retention.ts"),
      "@archive/worker/storageGuard": resolve(__dirname, "apps/worker/src/storageGuard.ts"),
      "@archive/worker/exportJob": resolve(__dirname, "apps/worker/src/exportJob.ts"),
      "@archive/worker/backupJob": resolve(__dirname, "apps/worker/src/backupJob.ts"),
      "@archive/worker/restoreJob": resolve(__dirname, "apps/worker/src/restoreJob.ts"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
