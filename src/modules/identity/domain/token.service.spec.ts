import { Test, type TestingModule } from "@nestjs/testing";
import { AppConfigService } from "../../../config/config.service";
import { TokenService } from "./token.service";

describe("TokenService", () => {
  let service: TokenService;

  beforeEach(async () => {
    const mockConfig = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === "AUTH_JWT_SECRET") return "dev-jwt-secret-at-least-32-characters-long-pe";
        if (key === "AUTH_JWT_KID") return "pe-key-2026-v1";
        return undefined;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TokenService,
        {
          provide: AppConfigService,
          useValue: mockConfig,
        },
      ],
    }).compile();

    service = module.get<TokenService>(TokenService);
  });

  describe("Access Token Signing & Verification", () => {
    it("should sign and verify valid JWT claims with HS256", async () => {
      const claims = {
        userId: "018f0000-0000-7000-8000-000000000001",
        schoolId: "018f0000-0000-7000-8000-000000000002",
        sessionId: "018f0000-0000-7000-8000-000000000003",
      };

      const { token, expiresIn } = await service.createAccessToken(claims);
      expect(typeof token).toBe("string");
      expect(expiresIn).toBe(900); // 15 min

      const verified = await service.verifyAccessToken(token);
      expect(verified.sub).toBe(claims.userId);
      expect(verified.schoolId).toBe(claims.schoolId);
      expect(verified.sessionId).toBe(claims.sessionId);
    });

    it("should reject tampered JWT tokens", async () => {
      const claims = {
        userId: "018f0000-0000-7000-8000-000000000001",
        schoolId: "018f0000-0000-7000-8000-000000000002",
        sessionId: "018f0000-0000-7000-8000-000000000003",
      };

      const { token } = await service.createAccessToken(claims);
      const tampered = `${token.slice(0, -5)}XXXXX`;

      await expect(service.verifyAccessToken(tampered)).rejects.toThrow(
        /Invalid or expired access token/,
      );
    });

    it("should reject tokens with alg: none or unsupported algorithms", async () => {
      // Craft an unsigned token with alg: none
      const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(
        JSON.stringify({
          sub: "user-1",
          schoolId: "school-1",
          sessionId: "sess-1",
          exp: Math.floor(Date.now() / 1000) + 900,
        }),
      ).toString("base64url");
      const noneToken = `${header}.${payload}.`;

      await expect(service.verifyAccessToken(noneToken)).rejects.toThrow(
        /Invalid or expired access token/,
      );
    });
  });

  describe("Refresh Token Generation & Hashing", () => {
    it("should generate cryptographically strong opaque tokens", () => {
      const t1 = service.generateRefreshToken();
      const t2 = service.generateRefreshToken();
      expect(t1).not.toBe(t2);
      expect(t1.length).toBeGreaterThanOrEqual(64);
    });

    it("should compute consistent SHA-256 hash", () => {
      const raw = "my-test-refresh-token-12345";
      const h1 = service.hashToken(raw);
      const h2 = service.hashToken(raw);
      expect(h1).toBe(h2);
      expect(h1).toHaveLength(64); // SHA-256 hex
    });
  });

  describe("Compound Refresh Token Format (<schoolId>.<rawToken>)", () => {
    it("should build and parse compound tokens correctly", () => {
      const schoolId = "018f0000-0000-7000-8000-000000000001";
      const raw = "sample-raw-refresh-token";

      const compound = service.buildCompoundRefreshToken(schoolId, raw);
      expect(compound).toBe(`${schoolId}.${raw}`);

      const parsed = service.parseCompoundRefreshToken(compound);
      expect(parsed.schoolId).toBe(schoolId);
      expect(parsed.rawToken).toBe(raw);
    });

    it("should reject malformed compound tokens without dot separator", () => {
      expect(() => service.parseCompoundRefreshToken("invalid-without-dot")).toThrow(
        /Malformed refresh token structure/,
      );
    });
  });
});
