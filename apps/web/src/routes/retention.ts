import type { FastifyInstance } from "fastify";
import type { Database } from "@archive/core";
import {
  createBackfill,
  getBackfillStatus,
  pauseBackfill,
  resumeBackfill,
} from "@archive/worker/backfill";
import { applyRetention, manualDeleteVersionData } from "@archive/worker/retention";
import { canAcquireStorage } from "@archive/worker/storageGuard";
import { requireCsrf, requireRole } from "../auth/guards.js";
import { recordAuditAction } from "./audit.js";

type HoldRow = {
  id: string;
  query_version_id: string;
  reason: string;
  created_by_user_id: string;
  created_at: Date;
  query_name: string;
  version_number: number;
};

type QueryVersionOptionRow = {
  id: string;
  connection_name: string;
  query_name: string;
  version_number: number;
};

export async function registerRetentionRoutes(
  app: FastifyInstance,
  db: Database,
): Promise<void> {
  app.get(
    "/api/admin/system/status",
    { preHandler: requireRole("admin") },
    async () => {
      const storage = canAcquireStorage();
      return { storage };
    },
  );

  app.get(
    "/api/admin/retention/holds",
    { preHandler: requireRole("admin") },
    async () => {
      const result = await db.query<HoldRow>(
        `SELECT rh.id, rh.query_version_id, rh.reason, rh.created_by_user_id, rh.created_at,
                qv.name AS query_name, qv.version_number
         FROM retention_holds rh
         JOIN query_versions qv ON qv.id = rh.query_version_id
         ORDER BY rh.created_at DESC`,
      );
      return {
        holds: result.rows.map((row) => ({
          id: row.id,
          queryVersionId: row.query_version_id,
          reason: row.reason,
          createdByUserId: row.created_by_user_id,
          createdAt: row.created_at.toISOString(),
          queryName: row.query_name,
          versionNumber: row.version_number,
        })),
      };
    },
  );

  app.get(
    "/api/admin/retention/query-versions",
    { preHandler: requireRole("admin") },
    async () => {
      const result = await db.query<QueryVersionOptionRow>(
        `SELECT qv.id, lc.name AS connection_name, qv.name AS query_name, qv.version_number
         FROM query_versions qv
         JOIN logscale_connections lc ON lc.id = qv.connection_id
         ORDER BY lc.name, qv.name, qv.version_number DESC`,
      );
      return {
        queryVersions: result.rows.map((row) => ({
          id: row.id,
          connectionName: row.connection_name,
          queryName: row.query_name,
          versionNumber: row.version_number,
        })),
      };
    },
  );

  app.post(
    "/api/admin/retention/holds",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      requireCsrf(request, reply);
      if (reply.sent) {
        return;
      }

      const body = request.body as { queryVersionId?: string; reason?: string };
      if (!body.queryVersionId || !body.reason?.trim()) {
        reply.code(400).send({ error: "missing_fields" });
        return;
      }

      const version = await db.query(`SELECT id FROM query_versions WHERE id = $1`, [
        body.queryVersionId,
      ]);
      if (!version.rows[0]) {
        reply.code(404).send({ error: "not_found" });
        return;
      }

      await db.query(
        `INSERT INTO retention_holds (query_version_id, reason, created_by_user_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (query_version_id) DO UPDATE
           SET reason = EXCLUDED.reason,
               created_by_user_id = EXCLUDED.created_by_user_id,
               created_at = now()`,
        [body.queryVersionId, body.reason.trim(), request.session!.user.id],
      );

      await recordAuditAction(db, request, "retention.hold", {
        queryVersionId: body.queryVersionId,
        reason: body.reason.trim(),
      });
      reply.code(201).send({ held: true });
    },
  );

  app.delete(
    "/api/admin/retention/holds/:queryVersionId",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      requireCsrf(request, reply);
      if (reply.sent) {
        return;
      }

      const { queryVersionId } = request.params as { queryVersionId: string };
      const result = await db.query(`DELETE FROM retention_holds WHERE query_version_id = $1`, [
        queryVersionId,
      ]);
      if ((result.rowCount ?? 0) === 0) {
        reply.code(404).send({ error: "not_found" });
        return;
      }

      await recordAuditAction(db, request, "retention.hold.release", { queryVersionId });
      reply.send({ released: true });
    },
  );

  app.post(
    "/api/admin/retention/apply",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      requireCsrf(request, reply);
      if (reply.sent) {
        return;
      }

      const outcome = await applyRetention(db);
      await recordAuditAction(db, request, "retention.apply", outcome);
      reply.send({ outcome });
    },
  );

  app.post(
    "/api/admin/retention/manual-delete",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      requireCsrf(request, reply);
      if (reply.sent) {
        return;
      }

      const body = request.body as { queryVersionId?: string; before?: string };
      if (!body.queryVersionId) {
        reply.code(400).send({ error: "missing_fields" });
        return;
      }

      const before = body.before ? new Date(body.before) : undefined;
      if (before && Number.isNaN(before.getTime())) {
        reply.code(400).send({ error: "invalid_before" });
        return;
      }

      const deleted = await manualDeleteVersionData(db, body.queryVersionId, before);
      reply.send({ deleted });
    },
  );

  app.post(
    "/api/admin/query-versions/:queryVersionId/backfill",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      requireCsrf(request, reply);
      if (reply.sent) {
        return;
      }

      const { queryVersionId } = request.params as { queryVersionId: string };
      const body = request.body as { start?: string; end?: string };
      if (!body.start || !body.end) {
        reply.code(400).send({ error: "missing_fields" });
        return;
      }

      try {
        const outcome = await createBackfill(db, queryVersionId, body.start, body.end);
        await recordAuditAction(db, request, "backfill.create", {
          queryVersionId,
          start: body.start,
          end: body.end,
          created: outcome.created,
          requeued: outcome.requeued,
        });
        const status = await getBackfillStatus(db, queryVersionId);
        reply.code(201).send({ status, created: outcome.created, requeued: outcome.requeued });
      } catch (error) {
        if (error instanceof Error && error.message === "not_found") {
          reply.code(404).send({ error: "not_found" });
          return;
        }
        if (error instanceof Error && error.message === "invalid_mode") {
          reply.code(409).send({ error: "invalid_mode" });
          return;
        }
        if (error instanceof Error && error.message === "inactive_query") {
          reply.code(409).send({ error: "inactive_query" });
          return;
        }
        if (error instanceof Error && error.message === "invalid_range") {
          reply.code(400).send({ error: "invalid_range" });
          return;
        }
        throw error;
      }
    },
  );

  app.get(
    "/api/admin/query-versions/:queryVersionId/backfill/status",
    { preHandler: requireRole("admin") },
    async (request) => {
      const { queryVersionId } = request.params as { queryVersionId: string };
      const status = await getBackfillStatus(db, queryVersionId);
      return { status };
    },
  );

  app.post(
    "/api/admin/query-versions/:queryVersionId/backfill/pause",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      requireCsrf(request, reply);
      if (reply.sent) {
        return;
      }

      const { queryVersionId } = request.params as { queryVersionId: string };
      const paused = await pauseBackfill(db, queryVersionId);
      await recordAuditAction(db, request, "backfill.pause", { queryVersionId, paused });
      reply.send({ paused });
    },
  );

  app.post(
    "/api/admin/query-versions/:queryVersionId/backfill/resume",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      requireCsrf(request, reply);
      if (reply.sent) {
        return;
      }

      const { queryVersionId } = request.params as { queryVersionId: string };
      try {
        const resumed = await resumeBackfill(db, queryVersionId);
        await recordAuditAction(db, request, "backfill.resume", { queryVersionId, resumed });
        reply.send({ resumed });
      } catch (error) {
        if (error instanceof Error && error.message === "not_found") {
          reply.code(404).send({ error: "not_found" });
          return;
        }
        if (error instanceof Error && error.message === "inactive_query") {
          reply.code(409).send({ error: "inactive_query" });
          return;
        }
        throw error;
      }
    },
  );
}
