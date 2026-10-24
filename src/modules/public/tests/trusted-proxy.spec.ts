import fastify, { type FastifyInstance } from "fastify";

describe("Trusted Proxy Configuration & IP Spoofing Protection", () => {
  describe("Default Configuration (trustProxy: false / TRUSTED_PROXY_COUNT: 0)", () => {
    let app: FastifyInstance;
    let serverAddress: string;

    beforeAll(async () => {
      app = fastify({
        trustProxy: false, // Default: direct connection, ignore X-Forwarded-For
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

    it("ignores spoofed X-Forwarded-For header and returns direct remote IP", async () => {
      const response = await fetch(`${serverAddress}/test-ip`, {
        headers: {
          "X-Forwarded-For": "203.0.113.195, 198.51.100.1",
        },
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { clientIp: string };
      // req.ip should be the direct socket address 127.0.0.1, NOT the spoofed header value
      expect(body.clientIp).toBe("127.0.0.1");
    });
  });

  describe("Configured Upstream Reverse Proxy (TRUSTED_PROXY_COUNT: 1)", () => {
    let app: FastifyInstance;
    let serverAddress: string;

    beforeAll(async () => {
      app = fastify({
        trustProxy: (_address: string, hop: number) => hop < 1, // Trust 1 hop (e.g. AWS ALB or Cloudflare proxy)
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

    it("extracts client IP from X-Forwarded-For when 1 proxy hop is trusted", async () => {
      const response = await fetch(`${serverAddress}/test-ip`, {
        headers: {
          "X-Forwarded-For": "203.0.113.195",
        },
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { clientIp: string };
      expect(body.clientIp).toBe("203.0.113.195");
    });
  });

  describe("Configured Trusted IP / CIDR List (TRUSTED_PROXIES)", () => {
    let app: FastifyInstance;
    let serverAddress: string;

    beforeAll(async () => {
      app = fastify({
        trustProxy: ["127.0.0.1"],
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

    it("trusts X-Forwarded-For when request arrives from trusted CIDR / proxy IP", async () => {
      const response = await fetch(`${serverAddress}/test-ip`, {
        headers: {
          "X-Forwarded-For": "203.0.113.195",
        },
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { clientIp: string };
      expect(body.clientIp).toBe("203.0.113.195");
    });
  });
});
