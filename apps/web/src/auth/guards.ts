import type { FastifyReply, FastifyRequest } from "fastify";
import type { ActiveSession, UserRole } from "@archive/core";

declare module "fastify" {
  interface FastifyRequest {
    session?: ActiveSession;
  }
}

export function requireRole(minimumRole: UserRole) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.session) {
      await reply.code(401).send({ error: "unauthenticated" });
      return;
    }

    if (minimumRole === "admin" && request.session.user.role !== "admin") {
      await reply.code(403).send({ error: "forbidden" });
    }
  };
}

export function requireCsrf(request: FastifyRequest, reply: FastifyReply): void {
  if (!request.session) {
    void reply.code(401).send({ error: "unauthenticated" });
    return;
  }

  const header = request.headers["x-csrf-token"];
  const token = Array.isArray(header) ? header[0] : header;
  if (!token || token !== request.session.csrfSecret) {
    void reply.code(403).send({ error: "invalid_csrf" });
  }
}
