# ADR-009: Account Recovery, Lifecycle Tokens, and Tenant Scoping (Phase 12b-1)

## Status
Accepted

## Context
ProgressEye requires secure account recovery (password reset), email verification, and first-login forced password change. Because these flows originate outside an active authenticated session, incoming HTTP requests do not carry a Bearer JWT containing the tenant identity (`schoolId`). Furthermore, PostgreSQL Row-Level Security (`progresseye_app` has `NOBYPASSRLS`) mandates that all tenant tables (`password_reset_tokens`, `email_verification_tokens`, `users`, `sessions`) must be accessed under an explicit tenant context.

Key architectural requirements:
1. **Tenant Binding**: Must identify the school tenant without using superuser `BYPASSRLS` privileges.
2. **Zero Leakage**: Tokens must never leak into server logs or HTTP `Referer` headers.
3. **Session Invalidation**: Password reset must revoke all existing sessions across all devices and never automatically log the user in.
4. **Anti-Enumeration**: Pre-auth endpoints must never disclose whether an account or school exists.
5. **Single-Use**: Lifecycle tokens must be single-use, and issuing a new reset token must invalidate previous unused ones.

## Decisions

### 1. Compound Lifecycle Tokens (`<schoolId>.<rawToken>`)
Following the pattern established for refresh tokens in ADR-008:
- The token distributed to users in email links is formatted as `<schoolId>.<rawToken>`.
- `rawToken` is generated using 32 cryptographically secure random bytes (`crypto.randomBytes(32).toString('hex')`, 256 bits of entropy).
- The endpoint parses `<schoolId>`, validates it as a valid non-nil UUIDv4/UUIDv7, and executes all database queries strictly inside `withTenant(schoolId)`.
- The database stores only `sha256(rawToken)` in `password_reset_tokens` and `email_verification_tokens`.
- Cross-tenant tampering (e.g. prefixing School B's UUID with a token generated for School A) fails closed: under `withTenant(schoolB)`, PostgreSQL RLS partitions query results to School B, where the token hash does not exist (0 rows returned).

### 2. URL Fragment Transport and Dedicated Public URL (`APP_PUBLIC_URL`)
- Reset and verification links are constructed using a dedicated configuration setting: **`APP_PUBLIC_URL`**.
- In production and staging environments (`APP_ENV === "production" | "staging"` or `NODE_ENV === "production"`), `env.schema.ts` refuses startup if `APP_PUBLIC_URL` is missing, empty, or points to `localhost` / `127.0.0.1`.
- **Fragment Transport**: To eliminate token leakage via HTTP `Referer` headers to external resources or web server access logs, the token is transported strictly in the URL hash fragment:
  - Password Reset: `${APP_PUBLIC_URL}/auth/reset-password#token=${schoolId}.${rawToken}`
  - Email Verification: `${APP_PUBLIC_URL}/auth/verify-email#token=${schoolId}.${rawToken}`
- Browsers never transmit URL fragments in HTTP request lines, protecting tokens from transit log exposure.

### 3. Password Reset, Session Invalidation, and Never-Auto-Login
- Password reset tokens expire in **1 hour** (NIST SP 800-63B).
- When a new password reset request is processed, any pre-existing unused tokens for that user are immediately invalidated (`used_at = CURRENT_TIMESTAMP(3)`).
- When a password reset is redeemed:
  - The token is marked `used_at = CURRENT_TIMESTAMP(3)`.
  - The new password is validated against NIST SP 800-63B (minimum 12 characters, no archaic composition rules) and zxcvbn (minimum score 3).
  - The user's `password_hash` is updated with Argon2id.
  - **All active sessions** across all devices for this user are immediately revoked (`revoked_at = CURRENT_TIMESTAMP(3)`).
  - The endpoint returns a generic success message and **never automatically issues an access token or session**. The user must explicitly authenticate with their new password.

### 4. First-Login Forced Password Change (`scope: "pwd_change_pending"`)
- If a user has `must_change_password === true`:
  - `POST /api/v1/auth/login` does not create a session and does not set the `pe_refresh_token` cookie.
  - Instead, it returns `{ mustChangePassword: true, temporaryToken: "..." }` containing a 15-minute JWT with claim `scope: "pwd_change_pending"`.
  - `JwtAuthGuard` explicitly inspects `claims.scope`: any request presenting `scope: "pwd_change_pending"` to protected resource routes is rejected with `403 Forbidden` (`"Password change required before accessing this resource."`).
  - Endpoint `POST /api/v1/auth/first-login-password` accepts `pwd_change_pending`, validates password strength, updates password, clears `must_change_password = false`, revokes older sessions, and issues a standard authenticated session.

### 5. Email Verification
- Email verification tokens expire in **24 hours**.
- Redeeming a verification token marks it `used_at = CURRENT_TIMESTAMP(3)` and sets `email_verified_at = CURRENT_TIMESTAMP(3)` on the user record.
- Replaying an already used verification token is rejected with `400 Bad Request`.

### 6. Anti-Enumeration & Anti-Abuse
- `POST /api/v1/auth/forgot-password` and `POST /api/v1/auth/verify-email/resend` return identical generic `200 OK` messages:
  `{ "message": "If an account matches that email, a password reset link has been sent." }`
  regardless of whether the school slug exists, the user exists, or the user is inactive.
- If the school or user is not found, a timing-safe dummy password verification is performed to equalize execution duration with the valid lookup path.
- **Timing Coarseness**: Note that timing comparison between existing and unknown accounts is coarse; exact wall-clock equality is not measured or guaranteed due to network jitter, queue latency, and garbage collection pauses.
- Pre-auth rate limits enforced via `AbusePreventionService`:
  - Forgot Password: max 10 requests per 15 min per IP; max 3 requests per 15 min per `(email, IP)` pair.
  - Resend Verification: max 3 requests per 15 min per `(email, IP)` pair.
  - Reset Password: max 10 attempts per 15 min per IP.

### 7. Email Delivery & UNVERIFIED Production Deliverability
- Auth emails are enqueued via BullMQ (`auth-email-notifications` queue) and dispatched using `SmtpEmailDeliveryService` (`nodemailer`).
- Local and CI environments connect strictly to Mailpit (`localhost:1025`).
- **UNVERIFIED**: Email deliverability to external consumer inboxes (SPF, DKIM, DMARC, SES reputation) is marked UNVERIFIED until production AWS SES onboarding.

### 8. Database Tables, Nil-UUID Constraints, & Minimal Role Grants
- New tables: `password_reset_tokens` and `email_verification_tokens`.
- Both tables have:
  - `school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE`
  - `CHECK (school_id <> '00000000-0000-0000-0000-000000000000'::uuid)`
  - `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`
  - Tenant isolation policy reusing Phase 11:
    `COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid`
- Minimal table role grants:
  - `progresseye_owner`: Table ownership only (no `GRANT ALL`).
  - `progresseye_app`: `SELECT, INSERT, UPDATE` (needed for token issuance and marking `used_at`; DELETE is intentionally excluded from `progresseye_app` until the future purge job in BACKLOG item 14).
  - `progresseye_ro`: `SELECT` only.

## Consequences
- Clean tenant partitioning under PostgreSQL RLS without requiring `BYPASSRLS`.
- Complete elimination of token leakage through URL query strings and access logs.
- Immediate revocation of compromised user sessions upon password reset.
