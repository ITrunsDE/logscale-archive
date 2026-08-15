import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Database } from "@archive/core";
import {
  checkDatabaseHealth,
  checkWorkerHealth,
  createBackup,
  getJobStats,
  getMaintenanceState,
  listAppliedMigrations,
  listBackupRuns,
} from "@archive/core";
import { canAcquireStorage } from "@archive/worker/storageGuard";
import { runRestoreJob } from "@archive/worker/restoreJob";
import { requireCsrf, requireRole } from "../auth/guards.js";
import { recordAuditAction } from "./audit.js";

function clientIp(request: FastifyRequest): string {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0]!.trim();
  }
  return request.ip;
}

export async function registerOperationsRoutes(
  app: FastifyInstance,
  db: Database,
): Promise<void> {
  app.get(
    "/api/admin/operations/status",
    { preHandler: requireRole("admin") },
    async () => {
      const [migrations, jobs, backups, dbOk] = await Promise.all([
        listAppliedMigrations(db),
        getJobStats(db),
        listBackupRuns(db),
        checkDatabaseHealth(db),
      ]);
      return {
        maintenance: getMaintenanceState(),
        storage: canAcquireStorage(),
        worker: checkWorkerHealth(),
        database: { ok: dbOk },
        migrations,
        jobs,
        backups,
      };
    },
  );

  app.get(
    "/api/admin/operations/backups",
    { preHandler: requireRole("admin") },
    async () => ({ backups: await listBackupRuns(db) }),
  );

  app.post(
    "/api/admin/operations/backups",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      requireCsrf(request, reply);
      if (reply.sent) {
        return;
      }

      try {
        const backup = await createBackup(db);
        await recordAuditAction(db, request, "backup.create", { backupId: backup.id });
        reply.code(201).send({ backup });
      } catch (error) {
        reply.code(500).send({
          error: "backup_failed",
          message: error instanceof Error ? error.message : "backup failed",
        });
      }
    },
  );

  app.post(
    "/api/admin/operations/restore",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      requireCsrf(request, reply);
      if (reply.sent) {
        return;
      }

      const body = request.body as { backupId?: string; confirmation?: string };
      if (!body.backupId || !body.confirmation) {
        reply.code(400).send({ error: "missing_fields" });
        return;
      }

      try {
        await recordAuditAction(db, request, "restore.start", { backupId: body.backupId });
        const outcome = await runRestoreJob(db, {
          backupId: body.backupId,
          confirmation: body.confirmation,
          actorUserId: request.session!.user.id,
          ip: clientIp(request),
        });
        reply.send({ outcome });
      } catch (error) {
        if (error instanceof Error && error.message === "Restore confirmation mismatch") {
          reply.code(400).send({ error: "confirmation_mismatch" });
          return;
        }
        if (error instanceof Error && error.message === "Backup not found") {
          reply.code(404).send({ error: "not_found" });
          return;
        }
        reply.code(500).send({
          error: "restore_failed",
          message: error instanceof Error ? error.message : "restore failed",
        });
      }
    },
  );
}
