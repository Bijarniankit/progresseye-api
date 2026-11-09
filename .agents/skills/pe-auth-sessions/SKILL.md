---
name: pe-auth-sessions
description: Standard operational rules for authentication, token lifecycles, session rotation, reuse detection, and compound refresh tokens in ProgressEye API.
---
# ProgressEye Authentication & Session Management Standard

## 1. Multi-Tenant Login & Compound Refresh Tokens
- **Slug-First Login**: User authentication requires `schoolSlug`, `email`, and `password`. The slug resolves the tenant ID (`schoolId`).
- **Access Tokens**: Short-lived JWTs (15 minutes), signed with `jose` HS256 (`AUTH_JWT_SECRET`). The payload contains `{ sub: userId, schoolId, sessionId, jti }`.
- **Tenant Context on Protected Requests**: Every protected request derives its tenant context strictly and exclusively from `req.user.schoolId` in the verified access token. Request headers (e.g. `X-School-Slug`, `x-school-id`) and request bodies are NEVER used to determine tenant context after login.
- **Compound Refresh Tokens**: Refresh tokens are stored in the database as SHA-256 hashes bound to `schoolId` under PostgreSQL RLS. Because refresh and logout requests arrive without a prior JWT tenant context, the cookie transports a compound token formatted as `<schoolId>.<rawToken>`:
  - The `schoolId` component is validated as a UUID.
  - The repository executes within `withTenant(schoolId)` using that UUID.
  - If an attacker tampers with `schoolId` to point to another tenant, the RLS policy and hash lookup fail closed (return 401).

## 2. Refresh Token Rotation & Reuse Detection
- **One-Time Use**: Refresh tokens are rotated upon every use. The consumed session row is marked `revoked_at = CURRENT_TIMESTAMP`, and a new successor session is created in the same transaction.
- **Grace Window**: To handle mobile network retries and concurrent duplicate refresh calls, a 10-second grace window is maintained. Any duplicate refresh request arriving within 10s of the rotation returns the exact same successor token rather than issuing a second one or triggering revocation.
- **Reuse / Replay Attack Revocation**: If a revoked refresh token is presented outside the grace window, it signifies a compromised token or replay attack. The entire session family (`familyId`) is immediately revoked across all devices for that login branch, and a security alert is recorded in audit logs.
- **Lifetimes**:
  - Refresh tokens have a 30-day sliding expiration (`expires_at`), extended upon rotation.
  - Absolute cap: 90 days from the initial login (`createdAt` of the session family root). Sessions are never extended beyond the 90-day absolute cap.

## 3. Cookie Transport & CSRF Protection
- **Cookie Flags**: Refresh tokens in browser contexts are transported via an `HttpOnly`, `SameSite=Lax`, `Secure` (in production), `Path=/api/v1/auth` cookie named `pe_refresh`.
- **SameSite Partitioned**: Not used (standard 1st-party same-origin architecture; staging and production use same-origin `/api` rewrites).
- **CSRF Defense**: All state-changing auth endpoints (`/refresh`, `/logout`, `/logout-all`) enforce Origin/Referer matching against the allowed frontend origins (`APP_URL` / `ALLOWED_ORIGINS`).
- **Mobile / Native Clients**: Clients specifying `clientType: "mobile"` receive the refresh token in the JSON response body and submit it via JSON body `{ "refreshToken": "<compound>" }`.

## 4. Password Hashing & NIST SP 800-63B Compliance
- **Argon2id**: Passwords are saved strictly as Argon2id hashes:
  - Production parameters: `memoryCost: 65536` (64 MiB), `timeCost: 3`, `parallelism: 1`.
  - Test parameters: `memoryCost: 4096` (4 MiB), `timeCost: 2`, `parallelism: 1`.
- **NIST Guidelines**:
  - Minimum 12 characters, maximum 128 characters.
  - All unicode characters, spaces, and punctuation permitted.
  - No arbitrary composition rules.
  - Evaluated with `@zxcvbn-ts/core` (minimum score of 3 required).
  - Breached password detection via HaveIBeenPwned k-anonymity API (disabled by default in dev/test via `AUTH_BREACHED_PASSWORD_CHECK_ENABLED=false`; fails open on network timeout/unreachable).
- **Timing-Safe Authentication**: Timing attacks are mitigated by executing dummy Argon2 verifications when users or schools are not found, returning generic "Invalid credentials." for all login failures.
