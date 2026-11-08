# ADR-008: Multi-Tenant Session and Token Architecture (Phase 12a)

## Status
Accepted

## Context
ProgressEye requires secure user authentication, session persistence, and tenant scoping in a multi-tenant environment protected by PostgreSQL Row-Level Security (RLS). Under RLS, the application role (`progresseye_app`) has `NOBYPASSRLS`. All tenant data, including users and sessions, is strictly partitioned by `school_id`.

Key architectural requirements:
1. **Login Lookup**: User accounts are identified by email within a school tenant.
2. **Token Security**: Short-lived access tokens, sliding refresh tokens, automatic token rotation, and reuse detection.
3. **Tenant Scoping**: RLS queries for refresh and logout requests arrive without a prior JWT authorization context.
4. **Anti-Abuse**: Protection against credential stuffing and brute-force attacks without enabling denial-of-service against victim accounts.

## Decision

### 1. Slug-First Login (D-042 Resolution)
We adopt **Option A: Slug-first login**. Users authenticate via `schoolSlug`, `email`, and `password`:
- The school slug resolves the school tenant metadata (`schoolId`).
- The login transaction runs under `withTenant(schoolId)` to query `users` under RLS.
- Dummy Argon2 verification executes on unknown school or user lookups to maintain timing-attack resistance.

### 2. Compound Refresh Tokens `<schoolId>.<refreshToken>`
Because refresh and logout requests do not carry a Bearer JWT, the database cannot know which tenant's RLS partition to query without a tenant context:
- The refresh token transported to the client is formatted as `<schoolId>.<rawToken>`.
- On refresh or logout, the endpoint splits the token, validates `schoolId` as a valid UUID, and executes the lookup under `withTenant(schoolId)`.
- The database stores only `sha256(rawToken)`, indexed alongside `school_id`.
- If an attacker tampers with `schoolId`, the lookup fails closed because the token hash does not exist in that foreign tenant's partition.

### 3. Token Rotation, Grace Window, and Family Revocation
- **One-time Use**: Refresh tokens are rotated on every use within an atomic database transaction.
- **Grace Window**: A 10-second grace window handles concurrent mobile network requests and retries. Duplicate requests within 10 seconds return the identical successor token.
- **Family Revocation**: Presentation of a revoked token outside the grace window indicates a token replay or theft. The entire session tree (`familyId`) is revoked immediately across all devices.
- **Lifetimes**: Access token = 15 minutes; Refresh token = 30 days sliding, capped at 90 days absolute from initial family creation.

### 4. Anti-DoS Lockout
- **Account + IP Pair Tracking**: Failed login attempts are tracked per `(emailHash, ipHash)` pair.
- 5 consecutive failures lock that IP out for that account for 15 minutes.
- Attackers attempting to brute-force a victim account from one IP do not lock out the legitimate user connecting from their own IP.
- Global per-IP rate limit caps total failed requests at 20 per 15 minutes.

### 5. Transport and Cookie Security
- Web clients receive refresh tokens in an `HttpOnly`, `SameSite=Lax`, `Path=/api/v1/auth` cookie named `pe_refresh`.
- SameSite `Partitioned` is omitted (unnecessary for 1st-party same-origin architecture with API rewrites).
- State-changing auth requests validate the `Origin` header against permitted frontend origins.
- Mobile clients obtain the refresh token in the response JSON and supply it in request bodies.

### 6. Audit Logging and Zero-Secret Redaction
- Pino logger redacts `refreshToken`, `password`, `code`, `secret`, and `otp`.
- Audit logs record security events using HMAC-SHA256 (`AUTH_LOG_HMAC_SECRET`) for emails and IP addresses.
- Application-level audit records are inserted into tenant `audit_logs` under RLS.
- Platform-level security telemetry (e.g. IP-level rate-limiting blocks) is routed to Pino structured logs pending the implementation of `platform_audit_logs`.

## Consequences
- Clean tenant isolation without requiring `BYPASSRLS` privileges for the application role.
- Transparent and safe token rotation with protection against mobile connection drops.
- Resilient brute-force mitigation without victim account lockouts.
