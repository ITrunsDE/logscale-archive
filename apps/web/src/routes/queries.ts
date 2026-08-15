import type { FastifyInstance } from "fastify";
import type { RuntimeConfig } from "@archive/config";
import type { Database } from "@archive/core";
import {
  activateQueryVersion,
  createQueryDraft,
  deactivateQueryVersion,
  deleteQueryVersion,
  listQueryNames,
  listQueryVersions,
  renameQuery,
  testQueryVersion,
  type QueryMode,
} from "@archive/core";
import { requireCsrf, requireRole } from "../auth/guards.js";
import { recordAuditAction } from "./audit.js";

export async function registerQueryRoutes(
  app: FastifyInstance,
  db: Database,
  config: RuntimeConfig,
): Promise<void> {
  const deps = { encryptionKey: config.encryptionKey };

  app.get(
    "/api/admin/query-versions",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      const { connectionId, name } = request.query as { connectionId?: string; name?: string };
      if (!connectionId) {
        reply.code(400).send({ error: "missing_fields" });
        return;
      }
      if (!name) {
        reply.send({ names: await listQueryNames(db, connectionId) });
        return;
      }
      const versions = await listQueryVersions(db, connectionId, name);
      reply.send({ versions });
    },
  );

  app.patch(
    "/api/admin/queries/rename",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      requireCsrf(request, reply);
      if (reply.sent) {
        return;
      }

      const body = request.body as {
        connectionId?: string;
        oldName?: string;
        newName?: string;
      };
      if (!body.connectionId || !body.oldName?.trim() || !body.newName?.trim()) {
        reply.code(400).send({ error: "missing_fields" });
        return;
      }

      try {
        await renameQuery(db, body.connectionId, body.oldName.trim(), body.newName.trim());
        await recordAuditAction(db, request, "query.rename", {
          connectionId: body.connectionId,
          oldName: body.oldName.trim(),
          newName: body.newName.trim(),
        });
        reply.send({ renamed: true, name: body.newName.trim() });
      } catch (error) {
        if (error instanceof Error && error.message === "not_found") {
          reply.code(404).send({ error: "not_found" });
          return;
        }
        if (error instanceof Error && error.message === "name_taken") {
          reply.code(409).send({ error: "name_taken" });
          return;
        }
        if (error instanceof Error && error.message === "invalid_name") {
          reply.code(400).send({ error: "invalid_name" });
          return;
        }
        throw error;
      }
    },
  );

  app.post(
    "/api/admin/query-versions/drafts",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      requireCsrf(request, reply);
      if (reply.sent) {
        return;
      }

      const body = request.body as {
        connectionId?: string;
        name?: string;
        queryText?: string;
        mode?: QueryMode;
        scheduleCron?: string | null;
        scheduleTimezone?: string;
        initialStartAt?: string;
        correctionWindowSeconds?: number;
        retentionDays?: number | null;
      };

      if (!body.connectionId || !body.name?.trim() || !body.queryText || !body.mode || !body.initialStartAt) {
        reply.code(400).send({ error: "missing_fields" });
        return;
      }

      try {
        const result = await createQueryDraft(db, {
          connectionId: body.connectionId,
          name: body.name.trim(),
          queryText: body.queryText,
          mode: body.mode,
          scheduleCron: body.scheduleCron ?? null,
          scheduleTimezone: body.scheduleTimezone,
          initialStartAt: body.initialStartAt,
          correctionWindowSeconds: body.correctionWindowSeconds,
          retentionDays: body.retentionDays,
        });
        await recordAuditAction(db, request, "query.draft.create", {
          queryVersionId: result.version.id,
          connectionId: result.version.connectionId,
          name: result.version.name,
          versionNumber: result.version.versionNumber,
        });
        reply.code(201).send(result);
      } catch (error) {
        if (error instanceof Error && error.message === "invalid_query") {
          reply.code(400).send({
            error: "invalid_query",
            validation: (error as Error & { validation?: { ok: boolean; errors: string[] } }).validation,
          });
          return;
        }
        if (error instanceof Error && error.message === "connection_not_found") {
          reply.code(404).send({ error: "connection_not_found" });
          return;
        }
        throw error;
      }
    },
  );

  app.post(
    "/api/admin/query-versions/:queryVersionId/test",
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

      const result = await testQueryVersion(db, deps, queryVersionId, {
        start: body.start,
        end: body.end,
      });
      await recordAuditAction(db, request, "query.test", {
        queryVersionId,
        ok: result.ok,
        eventCount: result.eventCount,
      });
      reply.send({ result });
    },
  );

  app.post(
    "/api/admin/query-versions/:queryVersionId/activate",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      requireCsrf(request, reply);
      if (reply.sent) {
        return;
      }

      const { queryVersionId } = request.params as { queryVersionId: string };
      try {
        await activateQueryVersion(db, queryVersionId);
        await recordAuditAction(db, request, "query.activate", { queryVersionId });
        reply.send({ activated: true });
      } catch (error) {
        if (error instanceof Error && error.message === "not_found") {
          reply.code(404).send({ error: "not_found" });
          return;
        }
        if (error instanceof Error && error.message === "test_required") {
          reply.code(409).send({ error: "test_required" });
          return;
        }
        throw error;
      }
    },
  );

  app.post(
    "/api/admin/query-versions/:queryVersionId/deactivate",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      requireCsrf(request, reply);
      if (reply.sent) {
        return;
      }

      const { queryVersionId } = request.params as { queryVersionId: string };
      try {
        await deactivateQueryVersion(db, queryVersionId);
        await recordAuditAction(db, request, "query.deactivate", { queryVersionId });
        reply.send({ deactivated: true });
      } catch (error) {
        if (error instanceof Error && error.message === "not_found") {
          reply.code(404).send({ error: "not_found" });
          return;
        }
        throw error;
      }
    },
  );

  app.delete(
    "/api/admin/query-versions/:queryVersionId",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      requireCsrf(request, reply);
      if (reply.sent) {
        return;
      }

      const { queryVersionId } = request.params as { queryVersionId: string };
      try {
        await deleteQueryVersion(db, queryVersionId);
        await recordAuditAction(db, request, "query.version.delete", { queryVersionId });
        reply.send({ deleted: true });
      } catch (error) {
        if (error instanceof Error && error.message === "not_found") {
          reply.code(404).send({ error: "not_found" });
          return;
        }
        if (error instanceof Error && error.message === "active_version") {
          reply.code(409).send({ error: "active_version" });
          return;
        }
        throw error;
      }
    },
  );
}
