import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Database } from "@archive/core";
import { listAuditEntries, writeAuditEntry } from "@archive/core";
import { requireRole } from "../auth/guards.js";

function clientIp(request: FastifyRequest): string {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0]!.trim();
  }
  return request.ip;
}

export async function recordAuditAction(
  db: Database,
  request: FastifyRequest,
  action: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await writeAuditEntry(db, {
    actorUserId: request.session?.user.id ?? null,
    action,
    ip: clientIp(request),
    metadata,
  });
}

export async function recordResultsSearchAudit(
  db: Database,
  request: FastifyRequest,
  metadata: { resultCount: number; filters?: Record<string, unknown> },
): Promise<void> {
  await recordAuditAction(db, request, "results.search", {
    resultCount: metadata.resultCount,
    filters: metadata.filters ?? {},
  });
}

export async function recordExportRequestAudit(
  db: Database,
  request: FastifyRequest,
  metadata: { resultCount?: number; format?: string; filters?: Record<string, unknown> },
): Promise<void> {
  await recordAuditAction(db, request, "exports.request", metadata);
}

export async function registerAuditRoutes(
  app: FastifyInstance,
  db: Database,
): Promise<void> {
  app.get(
    "/api/admin/audit",
    { preHandler: requireRole("admin") },
    async (request) => {
      const query = request.query as { limit?: string; offset?: string; action?: string };
      const entries = await listAuditEntries(db, {
        limit: query.limit ? Number(query.limit) : undefined,
        offset: query.offset ? Number(query.offset) : undefined,
        action: query.action,
      });
      return { entries };
    },
  );
}
