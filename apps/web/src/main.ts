import Fastify from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createOperationsLogger, loadConfig } from "@archive/config";
import {
  checkDatabaseHealth,
  checkWorkerHealth,
  createDatabase,
  isMaintenanceMode,
  migrateDatabase,
} from "@archive/core";
import { registerAuthRoutes, registerSessionHook } from "./routes/auth.js";
import { registerAdminUserRoutes } from "./routes/admin-users.js";
import { registerAuditRoutes } from "./routes/audit.js";
import { registerConfigExportRoutes } from "./routes/config-export.js";
import { registerExportRoutes } from "./routes/exports.js";
import { registerLogscaleConnectionRoutes } from "./routes/logscale-connections.js";
import { registerQueryRoutes } from "./routes/queries.js";
import { canAcquireStorage } from "@archive/worker/storageGuard";
import { registerRetentionRoutes } from "./routes/retention.js";
import { registerResultsRoutes } from "./routes/results.js";
import { registerOperationsRoutes } from "./routes/operations.js";

const WEB_ROOT = dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = join(WEB_ROOT, "../client");

export async function buildServer() {
  const config = loadConfig();
  const logger = createOperationsLogger("web", config.operationsLog);
  const db = createDatabase(config.databaseUrl);
  await migrateDatabase(config.databaseUrl);

  const app = Fastify({ logger: true, trustProxy: true });

  await app.register(cookie, {
    secret: config.sessionSecret,
    hook: "onRequest",
  });

  await registerSessionHook(app, db);

  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/")) {
      return;
    }
    if (request.url.startsWith("/api/auth")) {
      return;
    }
    if (!isMaintenanceMode()) {
      return;
    }
    if (request.session?.user.role === "admin") {
      return;
    }
    reply.code(503).send({ error: "maintenance" });
  });

  app.get("/healthz", async () => ({
    ok: true,
    role: "web",
  }));

  app.get("/api/status", async () => ({
    displayTimezone: config.displayTimezone,
    storage: canAcquireStorage(),
    worker: checkWorkerHealth(),
    database: { ok: await checkDatabaseHealth(db) },
  }));

  await registerAuthRoutes(app, db, config);
  await registerAdminUserRoutes(app, db);
  await registerConfigExportRoutes(app, db, config);
  await registerLogscaleConnectionRoutes(app, db, config);
  await registerQueryRoutes(app, db, config);
  await registerAuditRoutes(app, db);
  await registerRetentionRoutes(app, db);
  await registerResultsRoutes(app, db);
  await registerExportRoutes(app, db);
  await registerOperationsRoutes(app, db);

  const hasClient = existsSync(join(CLIENT_ROOT, "index.html"));
  if (hasClient) {
    await app.register(fastifyStatic, {
      root: CLIENT_ROOT,
      prefix: "/",
      wildcard: false,
    });

    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith("/api/")) {
        reply.code(404).send({ error: "not_found" });
        return;
      }
      return reply.sendFile("index.html");
    });
  } else {
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith("/api/")) {
        reply.code(404).send({ error: "not_found" });
        return;
      }
      reply.code(503).send({ error: "ui_not_built" });
    });
  }

  app.addHook("onClose", async () => {
    await logger.flush();
    await db.close();
  });

  return { app, config, db, logger };
}

async function main() {
  const config = loadConfig();
  if (config.role !== "web") {
    throw new Error(`web entrypoint requires APP_ROLE=web, got ${config.role}`);
  }

  const { app, logger } = await buildServer();
  await app.listen({ host: config.bindHost, port: config.port });
  logger.info("web.started", { port: config.port, bindHost: config.bindHost });
}

const isMain = process.argv[1]?.endsWith("main.ts") || process.argv[1]?.endsWith("main.js");
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
