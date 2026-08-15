import type { FastifyInstance, FastifyReply } from "fastify";
import type { RuntimeConfig } from "@archive/config";
import type { Database } from "@archive/core";
import {
  SESSION_COOKIE,
  countUsers,
  createSession,
  createUser,
  decodeSessionCookie,
  encodeSessionCookie,
  findUserById,
  findUserByUsername,
  getPasswordPolicy,
  resolveSession,
  revokeSession,
  revokeUserSessionsExcept,
  updateUserPassword,
  validatePassword,
  verifyPassword,
} from "@archive/core";
import {
  clearLoginFailures,
  isLoginLocked,
  recordLoginFailure,
} from "../auth/rate-limit.js";
import { requireCsrf } from "../auth/guards.js";
import { recordAuditAction } from "./audit.js";

function clientIp(request: { ip: string; headers: Record<string, unknown> }): string {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0]!.trim();
  }
  return request.ip;
}

function setSessionCookie(
  reply: FastifyReply,
  config: RuntimeConfig,
  sessionId: string,
  token: string,
  expiresAt: Date,
): void {
  reply.setCookie(SESSION_COOKIE, encodeSessionCookie(sessionId, token), {
    path: "/",
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "lax",
    signed: true,
    expires: expiresAt,
  });
}

function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  db: Database,
  config: RuntimeConfig,
): Promise<void> {
  app.get("/api/auth/status", async () => {
    const needsBootstrap = (await countUsers(db)) === 0;
    return { needsBootstrap };
  });

  app.get("/api/auth/me", async (request, reply) => {
    if (!request.session) {
      reply.code(401).send({ error: "unauthenticated" });
      return;
    }
    return {
      user: request.session.user,
      csrfToken: request.session.csrfSecret,
    };
  });

  app.post("/api/auth/bootstrap", async (request, reply) => {
    if ((await countUsers(db)) > 0) {
      reply.code(409).send({ error: "bootstrap_unavailable" });
      return;
    }

    const body = request.body as { username?: string; password?: string };
    const username = body.username?.trim();
    const password = body.password ?? "";
    if (!username) {
      reply.code(400).send({ error: "username_required" });
      return;
    }

    const policy = await getPasswordPolicy(db);
    const passwordErrors = validatePassword(password, policy);
    if (passwordErrors.length > 0) {
      reply.code(400).send({ error: "invalid_password", details: passwordErrors });
      return;
    }

    const user = await createUser(db, { username, password, role: "admin" });
    const session = await createSession(db, user.id);
    setSessionCookie(reply, config, session.sessionId, session.token, session.expiresAt);

    reply.code(201).send({
      user,
      csrfToken: session.csrfSecret,
    });
  });

  app.post("/api/auth/login", async (request, reply) => {
    const body = request.body as { username?: string; password?: string };
    const username = body.username?.trim() ?? "";
    const password = body.password ?? "";
    const ip = clientIp(request);

    if (!username || !password) {
      reply.code(400).send({ error: "credentials_required" });
      return;
    }

    if (isLoginLocked(ip, username)) {
      reply.code(429).send({ error: "too_many_attempts" });
      return;
    }

    const user = await findUserByUsername(db, username);
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      recordLoginFailure(ip, username);
      reply.code(401).send({ error: "invalid_credentials" });
      return;
    }

    clearLoginFailures(ip, username);
    const session = await createSession(db, user.id);
    setSessionCookie(reply, config, session.sessionId, session.token, session.expiresAt);

    reply.send({
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
      },
      csrfToken: session.csrfSecret,
    });
  });

  app.post("/api/auth/logout", async (request, reply) => {
    requireCsrf(request, reply);
    if (reply.sent) {
      return;
    }

    if (request.session) {
      await revokeSession(db, request.session.id);
    }
    clearSessionCookie(reply);
    reply.send({ ok: true });
  });

  app.post("/api/auth/password", async (request, reply) => {
    requireCsrf(request, reply);
    if (reply.sent) {
      return;
    }
    if (!request.session) {
      reply.code(401).send({ error: "unauthenticated" });
      return;
    }

    const body = request.body as { currentPassword?: string; newPassword?: string };
    const currentPassword = body.currentPassword ?? "";
    const newPassword = body.newPassword ?? "";
    if (!currentPassword || !newPassword) {
      reply.code(400).send({ error: "credentials_required" });
      return;
    }

    const user = await findUserById(db, request.session.user.id);
    if (!user || !(await verifyPassword(currentPassword, user.password_hash))) {
      reply.code(401).send({ error: "invalid_credentials" });
      return;
    }

    const policy = await getPasswordPolicy(db);
    const passwordErrors = validatePassword(newPassword, policy);
    if (passwordErrors.length > 0) {
      reply.code(400).send({ error: "invalid_password", details: passwordErrors });
      return;
    }

    await updateUserPassword(db, user.id, newPassword);
    await revokeUserSessionsExcept(db, user.id, request.session.id);
    await recordAuditAction(db, request, "auth.password_change", { userId: user.id });
    reply.send({ ok: true });
  });
}

export async function registerSessionHook(
  app: FastifyInstance,
  db: Database,
): Promise<void> {
  app.addHook("preHandler", async (request) => {
    const raw = request.cookies[SESSION_COOKIE];
    if (!raw) {
      return;
    }

    const unsigned = request.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) {
      return;
    }

    const parsed = decodeSessionCookie(unsigned.value);
    if (!parsed) {
      return;
    }

    request.session = (await resolveSession(db, parsed.sessionId, parsed.token)) ?? undefined;
  });
}
