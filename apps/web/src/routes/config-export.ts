import type { FastifyInstance } from "fastify";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { RuntimeConfig } from "@archive/config";
import type { Database } from "@archive/core";
import { requireRole } from "../auth/guards.js";
import { recordAuditAction } from "./audit.js";

type ConnectionRow = {
  name: string;
  endpoint: string;
  repository: string;
  status: string;
};

type QueryVersionRow = {
  connection_endpoint: string;
  connection_repository: string;
  name: string;
  version_number: number;
  query_text: string;
  mode: string;
  schedule_cron: string | null;
  schedule_timezone: string;
  initial_start_at: Date;
  correction_window_seconds: number;
  retention_days: number | null;
  active: boolean;
};

export type ConfigExportDocument = {
  version: 1;
  exportedAt: string;
  connections: Array<{
    name: string;
    endpoint: string;
    repository: string;
    status: string;
  }>;
  queryVersions: Array<{
    connectionEndpoint: string;
    connectionRepository: string;
    name: string;
    versionNumber: number;
    queryText: string;
    mode: string;
    scheduleCron: string | null;
    scheduleTimezone: string;
    initialStartAt: string;
    correctionWindowSeconds: number;
    retentionDays: number | null;
    active: boolean;
  }>;
};

const SECRET_FIELD_NAMES = new Set([
  "token",
  "token_ciphertext",
  "token_key_id",
  "tokenCiphertext",
  "tokenKeyId",
  "password",
  "secret",
  "ciphertext",
  "plaintext",
]);

function stripSecretFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripSecretFields);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  const clean: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(record)) {
    if (SECRET_FIELD_NAMES.has(key)) {
      continue;
    }
    clean[key] = stripSecretFields(nested);
  }
  return clean;
}

async function loadExportDocument(db: Database): Promise<ConfigExportDocument> {
  const connections = await db.query<ConnectionRow>(
    `SELECT name, endpoint, repository, status
     FROM logscale_connections
     ORDER BY name`,
  );

  const queryVersions = await db.query<QueryVersionRow>(
    `SELECT c.endpoint AS connection_endpoint,
            c.repository AS connection_repository,
            q.name,
            q.version_number,
            q.query_text,
            q.mode,
            q.schedule_cron,
            q.schedule_timezone,
            q.initial_start_at,
            q.correction_window_seconds,
            q.retention_days,
            q.active
     FROM query_versions q
     JOIN logscale_connections c ON c.id = q.connection_id
     ORDER BY c.name, q.name, q.version_number`,
  );

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    connections: connections.rows.map((row) => ({
      name: row.name,
      endpoint: row.endpoint,
      repository: row.repository,
      status: row.status,
    })),
    queryVersions: queryVersions.rows.map((row) => ({
      connectionEndpoint: row.connection_endpoint,
      connectionRepository: row.connection_repository,
      name: row.name,
      versionNumber: row.version_number,
      queryText: row.query_text,
      mode: row.mode,
      scheduleCron: row.schedule_cron,
      scheduleTimezone: row.schedule_timezone,
      initialStartAt: row.initial_start_at.toISOString(),
      correctionWindowSeconds: row.correction_window_seconds,
      retentionDays: row.retention_days,
      active: row.active,
    })),
  };
}

function buildImportPreview(document: unknown): ConfigExportDocument {
  const stripped = stripSecretFields(document) as Partial<ConfigExportDocument>;
  if (stripped.version !== 1) {
    throw new Error("Unsupported configuration export version");
  }

  return {
    version: 1,
    exportedAt: typeof stripped.exportedAt === "string" ? stripped.exportedAt : new Date().toISOString(),
    connections: (stripped.connections ?? []).map((connection) => ({
      name: String(connection.name ?? ""),
      endpoint: String(connection.endpoint ?? ""),
      repository: String(connection.repository ?? ""),
      status: String(connection.status ?? "unknown"),
    })),
    queryVersions: (stripped.queryVersions ?? []).map((version) => ({
      connectionEndpoint: String(version.connectionEndpoint ?? ""),
      connectionRepository: String(version.connectionRepository ?? ""),
      name: String(version.name ?? ""),
      versionNumber: Number(version.versionNumber ?? 0),
      queryText: String(version.queryText ?? ""),
      mode: String(version.mode ?? "event"),
      scheduleCron:
        version.scheduleCron === null || version.scheduleCron === undefined
          ? null
          : String(version.scheduleCron),
      scheduleTimezone: String(version.scheduleTimezone ?? "UTC"),
      initialStartAt: String(version.initialStartAt ?? new Date(0).toISOString()),
      correctionWindowSeconds: Number(version.correctionWindowSeconds ?? 0),
      retentionDays:
        version.retentionDays === null || version.retentionDays === undefined
          ? null
          : Number(version.retentionDays),
      active: false,
    })),
  };
}

function parseImportBody(raw: string, contentType: string | undefined): unknown {
  const normalized = contentType?.split(";")[0]?.trim().toLowerCase();
  if (normalized === "application/yaml" || normalized === "text/yaml") {
    return parseYaml(raw);
  }
  return JSON.parse(raw);
}

function serializeExport(document: ConfigExportDocument, format: "json" | "yaml"): string {
  if (format === "yaml") {
    return stringifyYaml(document);
  }
  return `${JSON.stringify(document, null, 2)}\n`;
}

export async function registerConfigExportRoutes(
  app: FastifyInstance,
  db: Database,
  _config: RuntimeConfig,
): Promise<void> {
  app.get(
    "/api/admin/config/export",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      const query = request.query as { format?: string };
      const format = query.format === "yaml" ? "yaml" : "json";
      const document = await loadExportDocument(db);

      await recordAuditAction(db, request, "config.export", {
        format,
        connectionCount: document.connections.length,
        queryVersionCount: document.queryVersions.length,
      });

      const body = serializeExport(document, format);
      reply
        .header("content-type", format === "yaml" ? "application/yaml" : "application/json")
        .send(body);
    },
  );

  app.post(
    "/api/admin/config/import/preview",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      const raw = typeof request.body === "string" ? request.body : JSON.stringify(request.body ?? {});
      const contentType = request.headers["content-type"];

      let parsed: unknown;
      try {
        parsed = parseImportBody(raw, contentType);
      } catch {
        reply.code(400).send({ error: "invalid_config" });
        return;
      }

      try {
        const preview = buildImportPreview(parsed);
        await recordAuditAction(db, request, "config.import.preview", {
          connectionCount: preview.connections.length,
          queryVersionCount: preview.queryVersions.length,
        });
        reply.send({ preview });
      } catch (error) {
        reply.code(400).send({
          error: "invalid_config",
          message: error instanceof Error ? error.message : "invalid configuration",
        });
      }
    },
  );
}
