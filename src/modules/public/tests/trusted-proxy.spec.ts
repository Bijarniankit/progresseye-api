import fastify, { type FastifyInstance } from "fastify";

describe("Trusted Proxy Configuration", () => {
  let app: FastifyInstance;
  let serverAddress: string;

  beforeAll(async () => {
    app = fastify({
      trustProxy: true,
    });

    app.get("/test-ip", (req, reply) => {
      reply.send({ clientIp: req.ip });
    });

    serverAddress = await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it("extracts real client IP from X-Forwarded-For when trustProxy is enabled", async () => {
    const response = await fetch(`${serverAddress}/test-ip`, {
      headers: {
        "X-Forwarded-For": "203.0.113.195, 192.0.2.1",
      },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { clientIp: string };
    expect(body.clientIp).toBe("203.0.113.195");
  });
});
