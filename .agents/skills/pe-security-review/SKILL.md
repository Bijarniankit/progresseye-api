---
name: pe-security-review
description: Security review and verification checklist for ProgressEye API covering RLS, timing-safe auth, anti-abuse defenses, and zero-secret logging.
---
# ProgressEye Security Review & Verification Standard

## 1. Zero-Secret Logging Integrity
- **Redacted Pino Keys**: Pino logger is configured to redact credentials, tokens, and secrets across all payload depths:
  `["req.headers.authorization", "req.headers.cookie", "*.password", "*.currentPassword", "*.newPassword", "*.refreshToken", "*.token", "*.secret", "*.otp", "*.code", "*.recoveryCode", "*.twoFactorSecret"]`.
- **HMAC Hashing for Identity Telemetry**:
  - Raw emails and client IP addresses must NEVER be logged in plain text in security audit logs or error logs.
  - Telemetry logs use `hmacHash(value, AUTH_LOG_HMAC_SECRET)` with SHA-256 HMAC, producing pseudonymized hashes that can be correlated for abuse investigation without leaking user PII or network IPs.
- **Verification Rule**: E2E security tests must assert that no plain password, refresh token, or bearer token appears in logger stream outputs.

## 2. Anti-DoS & Anti-Abuse Defenses
- **Per-IP Rate Limiting**: Max 20 failed login attempts per IP per 15-minute sliding window. Exceeding returns `429 Too Many Requests`.
- **Account + IP Pair Lockout**:
  - 5 consecutive failed login attempts from a given IP address for a specific user email locks that specific IP out for 15 minutes.
  - Crucial Anti-DoS Protection: An attacker attempting to brute-force an account from IP `A` does NOT lock out the legitimate user connecting from IP `B`.
- **Fail-Open External Dependencies**: Any optional security checks (such as HIBP breached-password k-anonymity API) must fail open on HTTP errors or timeouts so external outages cannot take down user authentication.

## 3. Database Privilege & RLS Integrity
- **Role Privileges**: Application connections run strictly under `progresseye_app` (`NOBYPASSRLS`). Table owners (`progresseye_owner`) are restricted to migration execution and CI setup.
- **Fail-Closed Queries**: Queries on tenant tables must always pass through `withTenant(schoolId)` within a parameterized transaction (`SET LOCAL app.current_school_id = $1`). Unset context defaults to nil-UUID `00000000-0000-0000-0000-000000000000`, returning 0 rows.
- **Audit Table Append-Only**: The `audit_logs` table grants only `SELECT, INSERT` to `progresseye_app`. Row modification (`UPDATE`) and deletion (`DELETE`) are revoked at the PostgreSQL engine level.

## 4. Cryptographic Key Management
- **Production Validation**: Startup validation rejects weak secrets, empty strings, and fallback dev secrets (such as `"dev-insecure-jwt-secret-min32byteslong!"`) in production environments (`NODE_ENV=production`).
- **Algorithm Pinning**: JWT verification explicitly enforces `algorithms: ["HS256"]`. Unsigned or `alg: none` tokens are rejected with 401.
