# ADR-010: TOTP Two-Factor Authentication, Recovery Codes, and SMS Stub (Phase 12b-2)

## Status
Accepted

## Context
ProgressEye requires multi-factor authentication (MFA) via RFC 6238 Time-based One-Time Passwords (TOTP), single-use recovery backup codes, and a stubbed SMS OTP flow. Because ProgressEye operates as a multi-tenant application with strict Row-Level Security (`progresseye_app` has `NOBYPASSRLS`), all 2FA secrets and recovery codes must be partitioned by `school_id` with rigorous database guarantees. Furthermore, authentication secrets must be encrypted at rest, codes must be protected against replay attacks, and brute-force guessing must be thwarted across both TOTP and recovery code channels.

## Decisions

### 1. Native Node Crypto TOTP Implementation (Zero 3rd-Party Dependencies)
- Rather than introducing `otplib` or third-party packages, TOTP is implemented directly using native Node.js `crypto`:
  - Algorithm: HMAC-SHA-1 (RFC 6238 / RFC 4226)
  - Secret Length: 20 random bytes (160 bits) encoded in RFC 4648 Base32 without padding.
  - Time Step: 30 seconds.
  - Verification Window: $\pm 1$ step (current step, $-30\,\text{s}$, $+30\,\text{s}$), covering a 90-second total verification envelope.
  - Dynamic Truncation: Standard RFC 4226 offset extraction yielding 6 numeric digits.
  - Setup URI: `otpauth://totp/<encodedIssuer>:<encodedEmail>?secret=<base32>&issuer=<encodedIssuer>&algorithm=SHA1&digits=6&period=30`.

### 2. Secret Encryption at Rest (AES-256-GCM)
- TOTP secrets are encrypted at rest prior to database persistence using AES-256-GCM with a dedicated key: **`AUTH_TOTP_ENC_KEY`**.
- `AUTH_TOTP_ENC_KEY` is completely segregated from `AUTH_JWT_SECRET` and `AUTH_GRACE_ENC_KEY`.
- In production and staging environments, `env.schema.ts` rejects missing, short (< 32 characters), or weak/default keys containing strings such as `insecure`, `default`, `changeme`, `secret`, `progress-eye-dev`, `123456`.
- Decryption with an incorrect key or tampered authentication tag safely throws an internal error and returns `null`.

### 3. Replay Protection and Redis-Down Degradation
- **Replay Protection**: When a valid code matches a time step, Redis records an atomic key via `SET auth:totp:replay:<userId>:<timeStep> 1 EX 120 NX`.
  - Replay TTL is set to 120 seconds (spanning the full ±1 step window: past step -30s, current step 0s, next step +30s, plus safety margin for step boundaries) vs the originally planned 90 seconds.
  - If the key already exists, the code is treated as replayed and rejected.
- **Redis-Down Degradation Mode**:
  - If Redis is unavailable during `POST /api/v1/auth/2fa/verify`, the endpoint throws `503 ServiceUnavailableException` (`"Authentication service temporarily unavailable. Please try again."`).
  - This 503 behavior is isolated strictly to the 2FA verify flow. Non-2FA logins and unrelated API routes remain fully functional.

### 4. Temporary Token Flow (`scope: "2fa_pending"`)
- When a user with `is_two_factor_enabled === true` authenticates with valid credentials at `POST /api/v1/auth/login`:
  - No active session or `pe_refresh_token` cookie is created.
  - The API responds with `{ requires2Fa: true, temporaryToken: "..." }`.
  - The token is a 5-minute JWT signed with `AUTH_JWT_SECRET` carrying claims `{ sub: userId, schoolId, scope: "2fa_pending" }`.
  - `JwtAuthGuard` explicitly rejects `scope: "2fa_pending"` on all resource routes with `403 Forbidden` (`"Two-factor authentication completion required before accessing this resource."`).
  - Only `POST /api/v1/auth/2fa/verify` and `POST /api/v1/auth/2fa/recovery` accept `2fa_pending` tokens.

### 5. Recovery Codes & Shared Attempt Cap
- **Format & Entropy**:
  - Exactly 8 recovery codes are generated upon 2FA enablement or regeneration.
  - Each code contains 10 characters from RFC 4648 Base32 (50 bits of entropy), displayed to the user as `XXXXX-XXXXX`.
- **Storage**:
  - The database table `user_recovery_codes` stores only the normalized SHA-256 hash (`code_hash`). Plaintext codes are displayed to the user exactly once.
  - Uniqueness is enforced on `(user_id, code_hash)` rather than a global unique constraint on `code_hash` alone, precluding cross-user hash collisions while preventing intra-user duplicate codes.
- **Single-Use**:
  - Redemption atomically sets `used_at = CURRENT_TIMESTAMP(3)`. Replayed recovery codes are rejected.
- **Shared Attempt Cap & Pre-Increment Risk**:
  - A single Redis counter (`auth:2fa:attempts:<userId>`, TTL 15 minutes) limits failed attempts across both TOTP and recovery code verification to a maximum of 5 attempts.
  - **Identified Risk**: Because `checkAndIncrementAttemptCap` executes before code verification, any actor holding a victim's temporary `2fa_pending` token could submit 5 bogus requests to deliberately exhaust the victim's attempt budget and trigger a 15-minute lockout (Denial of Service).
  - **Mitigations**:
    1. Short token lifetime: `2fa_pending` token expires in 5 minutes (`JWT_2FA_PENDING_EXPIRY = '5m'`).
    2. Multi-layered anti-abuse: Pre-login abuse controls (`AbusePreventionService`) enforce per-IP failure tracking and progressive delays, bounding token acquisition and automated abuse.
    3. Reset on success: Valid code submission immediately resets the counter (`DEL auth:2fa:attempts:<userId>`).
    4. Future roadmap mitigation: Record attempt increment only on verification failure (post-verification increment) or partition attempt budgets per client IP hash.
- **Generic Error Policy**:
  - In alignment with Amendment 1, any failure during 2FA verification (wrong code, replayed code, wrong recovery code, reused recovery code, expired temporary token, or cap exceeded) returns an identical generic error:
    `401 Unauthorized: "Invalid two-factor authentication credentials."`
  - No enumeration or error code distinction is leaked to clients.

### 6. Regeneration & Session Revocation
- Regenerating recovery codes (`POST /api/v1/auth/2fa/recovery/regenerate`) requires an active access-scope session and fresh password re-authentication.
- Regeneration revokes all previously issued recovery codes (`revoked_at = CURRENT_TIMESTAMP(3)`) and revokes all other active sessions for that user, preserving only the current active session.

### 7. Database & RLS Enforcement
- New tables: `user_two_factor_secrets` and `user_recovery_codes`.
- Schema guarantees:
  - Both tables contain `school_id UUID NOT NULL` and a check constraint ensuring non-nil UUID (`school_id <> '00000000-0000-0000-0000-000000000000'::uuid`).
  - Row-Level Security is enabled and forced:
    `ALTER TABLE ... ENABLE ROW LEVEL SECURITY;`
    `ALTER TABLE ... FORCE ROW LEVEL SECURITY;`
  - Tenant policy matches Phase 11:
    `USING (school_id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid)`
    `WITH CHECK (school_id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid);`
  - Table ownership: `OWNER TO progresseye_owner`.
  - App grants: `GRANT SELECT, INSERT, UPDATE ON ... TO progresseye_app;` (NO `DELETE` privilege granted).
  - Read-only grants: `GRANT SELECT ON ... TO progresseye_ro;`.

### 8. SMS OTP Stub
- Endpoint `POST /api/v1/auth/sms/send-otp` accepts `{ schoolSlug, email, phoneNumber }`.
- In stub mode, provider contact is completely suppressed.
- No phone numbers are persisted in the database.
- Logging masks the phone number (e.g. `+1 ***-***-1234`), and OTP tokens are never written to logs.
- The endpoint returns a generic acknowledgment:
  `{ "message": "If this account is eligible for SMS verification, a one-time code has been dispatched." }`.
