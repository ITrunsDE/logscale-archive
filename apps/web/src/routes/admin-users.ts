import type { FastifyInstance } from "fastify";
import type { Database } from "@archive/core";
import {
  createUser,
  deleteUser,
  findUserById,
  generateCompliantPassword,
  getPasswordPolicy,
  listUsers,
  revokeUserSessions,
  updatePasswordPolicy,
  updateUserPassword,
  validatePassword,
} from "@archive/core";
import { requireCsrf, requireRole } from "../auth/guards.js";
import { recordAuditAction } from "./audit.js";

export async function registerAdminUserRoutes(
  app: FastifyInstance,
  db: Database,
): Promise<void> {
  app.get(
    "/api/admin/users",
    { preHandler: requireRole("admin") },
    async () => ({ users: await listUsers(db) }),
  );

  app.post(
    "/api/admin/users",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      requireCsrf(request, reply);
      if (reply.sent) {
        return;
      }

      const body = request.body as { username?: string; password?: string; role?: string };
      const username = body.username?.trim();
      const password = body.password ?? "";
      const role = body.role;

      if (!username) {
        reply.code(400).send({ error: "username_required" });
        return;
      }
      if (role !== "admin" && role !== "viewer") {
        reply.code(400).send({ error: "invalid_role" });
        return;
      }

      const policy = await getPasswordPolicy(db);
      const passwordErrors = validatePassword(password, policy);
      if (passwordErrors.length > 0) {
        reply.code(400).send({ error: "invalid_password", details: passwordErrors });
        return;
      }

      try {
        const user = await createUser(db, { username, password, role });
        reply.code(201).send({ user });
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "23505") {
          reply.code(409).send({ error: "username_taken" });
          return;
        }
        throw error;
      }
    },
  );

  app.delete(
    "/api/admin/users/:userId",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      requireCsrf(request, reply);
      if (reply.sent) {
        return;
      }

      const { userId } = request.params as { userId: string };
      const outcome = await deleteUser(db, userId);
      if (outcome === "not_found") {
        reply.code(404).send({ error: "not_found" });
        return;
      }
      if (outcome === "protected") {
        reply.code(403).send({ error: "protected_user" });
        return;
      }
      await recordAuditAction(db, request, "admin.user_delete", { targetUserId: userId });
      reply.code(204).send();
    },
  );

  app.post(
    "/api/admin/users/:userId/revoke-sessions",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      requireCsrf(request, reply);
      if (reply.sent) {
        return;
      }

      const { userId } = request.params as { userId: string };
      const revoked = await revokeUserSessions(db, userId);
      reply.send({ revoked });
    },
  );

  app.post(
    "/api/admin/users/:userId/password",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      requireCsrf(request, reply);
      if (reply.sent) {
        return;
      }

      const { userId } = request.params as { userId: string };
      const target = await findUserById(db, userId);
      if (!target) {
        reply.code(404).send({ error: "not_found" });
        return;
      }

      const body = request.body as { password?: string; generate?: boolean };
      const policy = await getPasswordPolicy(db);
      let password = body.password ?? "";
      let generated = false;

      if (body.generate === true) {
        password = generateCompliantPassword(policy);
        generated = true;
      } else if (!password) {
        reply.code(400).send({ error: "invalid_body" });
        return;
      } else {
        const passwordErrors = validatePassword(password, policy);
        if (passwordErrors.length > 0) {
          reply.code(400).send({ error: "invalid_password", details: passwordErrors });
          return;
        }
      }

      await updateUserPassword(db, userId, password);
      await revokeUserSessions(db, userId);
      await recordAuditAction(db, request, "admin.password_reset", { targetUserId: userId });

      if (generated) {
        reply.send({ ok: true, generatedPassword: password });
        return;
      }
      reply.send({ ok: true });
    },
  );

  app.get(
    "/api/admin/password-policy",
    { preHandler: requireRole("admin") },
    async () => ({ policy: await getPasswordPolicy(db) }),
  );

  app.put(
    "/api/admin/password-policy",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      requireCsrf(request, reply);
      if (reply.sent) {
        return;
      }

      const body = request.body as {
        minLength?: number;
        requireUpper?: boolean;
        requireLower?: boolean;
        requireDigit?: boolean;
        requireSymbol?: boolean;
        historyCount?: number;
      };

      try {
        const policy = await updatePasswordPolicy(db, {
          minLength: Number(body.minLength),
          requireUpper: Boolean(body.requireUpper),
          requireLower: Boolean(body.requireLower),
          requireDigit: Boolean(body.requireDigit),
          requireSymbol: Boolean(body.requireSymbol),
          historyCount: Number(body.historyCount ?? 0),
        });
        reply.send({ policy });
      } catch (error) {
        reply.code(400).send({
          error: "invalid_policy",
          message: error instanceof Error ? error.message : "invalid policy",
        });
      }
    },
  );
}
