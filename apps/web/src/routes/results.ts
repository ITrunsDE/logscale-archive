import type { FastifyInstance } from "fastify";
import type { Database } from "@archive/core";
import { listSearchableQueryVersions, searchStoredResults } from "@archive/core";
import { requireCsrf, requireRole } from "../auth/guards.js";
import { recordResultsSearchAudit } from "./audit.js";

export async function registerResultsRoutes(
  app: FastifyInstance,
  db: Database,
): Promise<void> {
  app.get(
    "/api/results/query-versions",
    { preHandler: requireRole("viewer") },
    async () => ({ versions: await listSearchableQueryVersions(db) }),
  );

  app.post(
    "/api/results/search",
    { preHandler: requireRole("viewer") },
    async (request, reply) => {
      requireCsrf(request, reply);
      if (reply.sent) {
        return;
      }

      const body = request.body as {
        queryVersionId?: string;
        from?: string;
        to?: string;
        jsonFilters?: Array<{ field?: string; value?: string }>;
        limit?: number;
        offset?: number;
      };

      if (!body.queryVersionId) {
        reply.code(400).send({ error: "missing_fields" });
        return;
      }

      const jsonFilters = (body.jsonFilters ?? [])
        .filter((filter) => filter.value?.trim())
        .map((filter) => ({
          field: filter.field?.trim() ?? "",
          value: filter.value!.trim(),
        }));

      try {
        const results = await searchStoredResults(
          db,
          {
            queryVersionId: body.queryVersionId,
            from: body.from,
            to: body.to,
            jsonFilters,
            limit: body.limit,
            offset: body.offset,
          },
          {
            userId: request.session!.user.id,
            role: request.session!.user.role,
          },
        );

        await recordResultsSearchAudit(db, request, {
          resultCount: results.total,
          filters: {
            queryVersionId: body.queryVersionId,
            from: body.from,
            to: body.to,
            jsonFilters,
          },
        });

        reply.send({ results });
      } catch (error) {
        if (error instanceof Error && error.message === "query_version_not_found") {
          reply.code(404).send({ error: "not_found" });
          return;
        }
        throw error;
      }
    },
  );
}
