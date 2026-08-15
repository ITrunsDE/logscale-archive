import type { FastifyInstance } from "fastify";
import type { RuntimeConfig } from "@archive/config";
import type { Database } from "@archive/core";
import {
  decryptSecret,
  encryptSecret,
  encryptedSecretFromBytes,
  encryptedSecretToBytes,
  validateConnection,
} from "@archive/core";
import { requireCsrf, requireRole } from "../auth/guards.js";
import { recordAuditAction } from "./audit.js";

type ConnectionRow = {
  id: string;
  name: string;
  endpoint: string;
  repository: string;
  status: string;
  last_validated_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type PublicConnection = {
  id: string;
  name: string;
  endpoint: string;
  repository: string;
  status: string;
  lastValidatedAt: string | null;
  tokenExpiryWarning: string | null;
};

const EXPIRY_WARNING_DAYS = 14;

function toPublicConnection(row: ConnectionRow): PublicConnection {
  return {
    id: row.id,
    name: row.name,
    endpoint: row.endpoint,
    repository: row.repository,
    status: row.status,
    lastValidatedAt: row.last_validated_at?.toISOString() ?? null,
    tokenExpiryWarning: null,
  };
}

function expiryWarning(expiresAt: string | undefined): string | null {
  if (!expiresAt) {
    return null;
  }
  const expiry = new Date(expiresAt);
  if (Number.isNaN(expiry.getTime())) {
    return null;
  }
  const days = (expiry.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
  if (days <= 0) {
    return "Token appears expired";
  }
  if (days <= EXPIRY_WARNING_DAYS) {
    return `Token expires in ${Math.ceil(days)} day(s)`;
  }
  return null;
}

async function listConnections(db: Database): Promise<PublicConnection[]> {
  const result = await db.query<ConnectionRow>(
    `SELECT id, name, endpoint, repository, status, last_validated_at, created_at, updated_at
     FROM logscale_connections
     ORDER BY name`,
  );
  return result.rows.map(toPublicConnection);
}

export async function registerLogscaleConnectionRoutes(
  app: FastifyInstance,
  db: Database,
  config: RuntimeConfig,
): Promise<void> {
  app.get(
    "/api/admin/logscale-connections",
    { preHandler: requireRole("admin") },
    async () => ({ connections: await listConnections(db) }),
  );

  app.post(
    "/api/admin/logscale-connections",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      requireCsrf(request, reply);
      if (reply.sent) {
        return;
      }

      const body = request.body as {
        name?: string;
        endpoint?: string;
        repository?: string;
        token?: string;
      };
      const name = body.name?.trim();
      const endpoint = body.endpoint?.trim().replace(/\/+$/, "");
      const repository = body.repository?.trim();
      const token = body.token?.trim();

      if (!name || !endpoint || !repository || !token) {
        reply.code(400).send({ error: "missing_fields" });
        return;
      }

      const encrypted = encryptSecret(token, config.encryptionKey);
      try {
        const inserted = await db.query<ConnectionRow>(
          `INSERT INTO logscale_connections
             (name, endpoint, repository, token_ciphertext, token_key_id, status)
           VALUES ($1, $2, $3, $4, $5, 'unknown')
           RETURNING id, name, endpoint, repository, status, last_validated_at, created_at, updated_at`,
          [name, endpoint, repository, encryptedSecretToBytes(encrypted), config.encryptionKeyId],
        );
        const connection = toPublicConnection(inserted.rows[0]!);
        await recordAuditAction(db, request, "logscale.connection.create", {
          connectionId: connection.id,
          name: connection.name,
          endpoint: connection.endpoint,
          repository: connection.repository,
        });
        reply.code(201).send({ connection });
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "23505") {
          reply.code(409).send({ error: "connection_exists" });
          return;
        }
        throw error;
      }
    },
  );

  app.post(
    "/api/admin/logscale-connections/:connectionId/validate",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      requireCsrf(request, reply);
      if (reply.sent) {
        return;
      }

      const { connectionId } = request.params as { connectionId: string };
      const row = await db.query<ConnectionRow & { token_ciphertext: Buffer }>(
        `SELECT id, name, endpoint, repository, status, last_validated_at, created_at, updated_at, token_ciphertext
         FROM logscale_connections
         WHERE id = $1`,
        [connectionId],
      );
      if (row.rows.length === 0) {
        reply.code(404).send({ error: "not_found" });
        return;
      }

      const connection = row.rows[0]!;
      const token = decryptSecret(
        encryptedSecretFromBytes(connection.token_ciphertext),
        config.encryptionKey,
      );
      const validation = await validateConnection({
        endpoint: connection.endpoint,
        repository: connection.repository,
        token,
      });

      const status = validation.ok
        ? "valid"
        : validation.repositoryAccessible
          ? "warning"
          : "invalid";
      await db.query(
        `UPDATE logscale_connections
         SET status = $2, last_validated_at = now(), updated_at = now()
         WHERE id = $1`,
        [connectionId, status],
      );

      const publicConnection = toPublicConnection({
        ...connection,
        status,
        last_validated_at: new Date(),
      });
      publicConnection.tokenExpiryWarning = expiryWarning(validation.tokenExpiresAt);

      await recordAuditAction(db, request, "logscale.connection.validate", {
        connectionId,
        ok: validation.ok,
        repositoryAccessible: validation.repositoryAccessible,
        permissionWarningCount: validation.permissionWarnings.length,
      });

      reply.send({ connection: publicConnection, validation });
    },
  );

  app.delete(
    "/api/admin/logscale-connections/:connectionId",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      requireCsrf(request, reply);
      if (reply.sent) {
        return;
      }

      const { connectionId } = request.params as { connectionId: string };
      const deleted = await db.query(
        "DELETE FROM logscale_connections WHERE id = $1 RETURNING id, name",
        [connectionId],
      );
      if (deleted.rows.length === 0) {
        reply.code(404).send({ error: "not_found" });
        return;
      }

      await recordAuditAction(db, request, "logscale.connection.delete", {
        connectionId,
        name: deleted.rows[0]!.name,
      });
      reply.send({ deleted: true });
    },
  );
}
