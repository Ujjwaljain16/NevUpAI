import { FastifyRequest, FastifyReply } from "fastify";
import jwt, { JwtPayload } from "jsonwebtoken";
import { env } from "../../config/env";

type AuthPayload = JwtPayload & {
  sub?: string;
  role?: string;
  iat?: number;
  exp?: number;
};

function getBearerToken(request: FastifyRequest): string | null {
  const authHeader = request.headers.authorization;
  if (!authHeader) {
    return null;
  }

  const [scheme, token] = authHeader.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return null;
  }
  return token;
}

export async function authMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const token = getBearerToken(request);
  
  if (!token) {
    throw Object.assign(new Error("Missing or invalid token"), { statusCode: 401 });
  }

  let payload: AuthPayload;
  try {
    payload = jwt.verify(token, env.jwtSecret, { algorithms: ["HS256"] }) as AuthPayload;
  } catch (err) {
    throw Object.assign(new Error("Invalid or expired token"), { statusCode: 401 });
  }

  if (!payload.sub || !payload.role || !payload.iat || !payload.exp) {
    throw Object.assign(new Error("Token missing required claims"), { statusCode: 401 });
  }

  if (payload.role !== "trader") {
    throw Object.assign(new Error("Invalid role"), { statusCode: 401 });
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) {
    throw Object.assign(new Error("Token expired"), { statusCode: 401 });
  }

  request.user = {
    userId: payload.sub,
    role: payload.role,
    iat: payload.iat,
    exp: payload.exp,
  };

  if (request.appContext) {
    request.appContext.userId = request.user.userId;
  }
}
