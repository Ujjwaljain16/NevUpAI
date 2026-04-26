import { authMiddleware } from "../../src/modules/auth/auth.middleware";
import { tenancyMiddleware } from "../../src/modules/auth/tenancy.middleware";
import { FastifyRequest, FastifyReply } from "fastify";
import jwt from "jsonwebtoken";
import { env } from "../../src/config/env";

import "../../src/types/fastify.d.ts";

describe("Auth Middleware Unit", () => {
  let mockReq: any;
  let mockReply: Partial<FastifyReply>;

  beforeEach(() => {
    mockReq = {
      headers: {},
      appContext: { traceId: "test" }
    };
    mockReply = {
      status: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis()
    };
  });

  it("should throw 401 if token is missing", async () => {
    await expect(authMiddleware(mockReq as any, mockReply as any))
      .rejects.toMatchObject({ statusCode: 401 });
  });

  it("should validate a correct token and set request.user", async () => {
    const userId = "12345";
    const token = jwt.sign({ 
      sub: userId, 
      role: "trader", 
      iat: Math.floor(Date.now()/1000), 
      exp: Math.floor(Date.now()/1000) + 60 
    }, env.jwtSecret);
    
    mockReq.headers = { authorization: `Bearer ${token}` };

    await authMiddleware(mockReq as any, mockReply as any);
    expect(mockReq.user?.userId).toBe(userId);
  });
});

describe("Tenancy Middleware Unit", () => {
  it("should throw 403 if userId in body does not match token", async () => {
    const mockReq: any = {
      user: { userId: "user-A" },
      body: { userId: "user-B" },
      params: {},
      appContext: { traceId: "test" }
    };
    const mockReply: any = {};

    await expect(tenancyMiddleware(mockReq, mockReply))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  it("should pass if userId in body matches token", async () => {
    const mockReq: any = {
      user: { userId: "user-A" },
      body: { userId: "user-A" },
      params: {},
      appContext: { traceId: "test" }
    };
    const mockReply: any = {};

    await expect(tenancyMiddleware(mockReq, mockReply)).resolves.not.toThrow();
  });
});
