import { createReadStream } from "node:fs";
import type { FastifyInstance } from "fastify";
import type { Database } from "@archive/core";
import {
  canDownloadExport,
  createExport,
  getExport,
  listExports,
  type ExportFormat,
  type StoredResultFilters,
} from "@archive/core";
import { requireCsrf, requireRole } from "../auth/guards.js";
import { recordExportRequestAudit } from "./audit.js";

export async function registerExportRoutes(
  app: FastifyInstance,
  db: Database,
): Promise<void> {
  app.get(
    "/api/exports",
    { preHandler: requireRole("viewer") },
    async (request) => ({
      exports: await listExports(
        db,
        request.session!.user.id,
        request.session!.user.role,
      ),
    }),
  );

  app.post(
    "/api/exports",
    { preHandler: requireRole("viewer") },
    async (request, reply) => {
      requireCsrf(request, reply);
      if (reply.sent) {
        return;
      }

      const body = request.body as {
        queryVersionId?: string;
        format?: ExportFormat;
        filters?: StoredResultFilters;
      };

      if (!body.queryVersionId || (body.format !== "csv" && body.format !== "ndjson")) {
        reply.code(400).send({ error: "missing_fields" });
        return;
      }

      const filters: StoredResultFilters = {
        queryVersionId: body.queryVersionId,
        from: body.filters?.from,
        to: body.filters?.to,
        jsonFilters: body.filters?.jsonFilters,
      };

      const job = await createExport(db, {
        queryVersionId: body.queryVersionId,
        format: body.format,
        filters,
        requestedByUserId: request.session!.user.id,
      });

      await recordExportRequestAudit(db, request, {
        format: body.format,
        filters: {
          queryVersionId: body.queryVersionId,
          from: filters.from,
          to: filters.to,
          jsonFilters: filters.jsonFilters,
        },
      });

      reply.code(201).send({ export: job });
    },
  );

  app.get(
    "/api/exports/:exportId",
    { preHandler: requireRole("viewer") },
    async (request, reply) => {
      const { exportId } = request.params as { exportId: string };
      const job = await getExport(db, exportId);
      if (!job) {
        reply.code(404).send({ error: "not_found" });
        return;
      }
      if (
        !canDownloadExport(job, request.session!.user.id, request.session!.user.role)
      ) {
        reply.code(403).send({ error: "forbidden" });
        return;
      }
      reply.send({ export: job });
    },
  );

  app.get(
    "/api/exports/:exportId/download",
    { preHandler: requireRole("viewer") },
    async (request, reply) => {
      const { exportId } = request.params as { exportId: string };
      const job = await getExport(db, exportId);
      if (!job) {
        reply.code(404).send({ error: "not_found" });
        return;
      }
      if (
        !canDownloadExport(job, request.session!.user.id, request.session!.user.role)
      ) {
        reply.code(403).send({ error: "forbidden" });
        return;
      }
      if (job.status !== "complete" || !job.filePath) {
        reply.code(409).send({ error: "not_ready" });
        return;
      }

      const contentType =
        job.format === "csv" ? "text/csv" : "application/x-ndjson";
      reply.header("content-type", contentType);
      reply.header(
        "content-disposition",
        `attachment; filename="export-${job.id}.${job.format}"`,
      );
      return reply.send(createReadStream(job.filePath));
    },
  );
}
