import { FastifyRequest, FastifyReply } from "fastify";
import jwt, { JwtPayload } from "jsonwebtoken";
import { env } from "../../config/env";

type AuthPayload = JwtPayload & {
  sub?: string;
  role?: string;
  iat?: number;
  exp?: number;
};

// Extracts token from standard Authorization header
function getBearerToken(request: FastifyRequest): string | null {
  const authHeader = request.headers.authorization;
  if (!authHeader) return null;

  const [scheme, token] = authHeader.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

// Perimeter security: verifies identity and establishes request tenancy
export async function authMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const token = getBearerToken(request);
  
  if (!token) {
    throw Object.assign(new Error("Missing or invalid token"), { statusCode: 401 });
  }

  let payload: AuthPayload;
  try {
    // HS256 algorithm is explicitly enforced to prevent algorithm-switching attacks
    payload = jwt.verify(token, env.jwtSecret, { algorithms: ["HS256"] }) as AuthPayload;
  } catch (err) {
    throw Object.assign(new Error("Invalid or expired token"), { statusCode: 401 });
  }

  // Ensures all required claims are present to avoid downstream partial-user logic failures
  if (!payload.sub || !payload.role || !payload.iat || !payload.exp) {
    throw Object.assign(new Error("Token missing required claims"), { statusCode: 401 });
  }

  // Role-based access control (RBAC) specifically for the trader ecosystem
  if (payload.role !== "trader") {
    throw Object.assign(new Error("Invalid role"), { statusCode: 401 });
  }

  // Manual expiration check serves as a safety layer above the JWT library defaults
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) {
    throw Object.assign(new Error("Token expired"), { statusCode: 401 });
  }

  // Hydrates request with user identity for downstream business logic
  request.user = {
    userId: payload.sub,
    role: payload.role,
    iat: payload.iat,
    exp: payload.exp,
  };

  // Maps identity to appContext for unified trace logging
  if (request.appContext) {
    request.appContext.userId = request.user.userId;
  }
}
