# ProgressEye — Threat Model & Security Posture

## 1. Multi-Tenant Isolation
- **Row-Level Security (RLS)**: PostgreSQL RLS enforced on every tenant-scoped table via `school_id`.
- **Session Context**: The active `school_id` and user context are set on each pooled connection prior to executing transactions.
- **Cross-Tenant Prevention**: Zero trust between tenants. Every query must test and verify that data cannot leak across tenant boundaries.

## 2. Authentication & Session Management
- **Passwords**: Hashed with Argon2id using salt and high memory cost (`memoryCost: 65536`, `timeCost: 3`, `parallelism: 1` in production). NIST SP 800-63B compliant: 12-128 chars, no arbitrary composition rules, zxcvbn evaluation (minimum score 3), and breached-password k-anonymity check.
- **Tokens**: Short-lived access tokens (JWT, 15m), compound refresh tokens (`<schoolId>.<token>`) with automatic reuse detection, 10s grace window for concurrent requests, and session family revocation on replay outside the window.
- **Cookie Security**: `HttpOnly`, `SameSite=Lax`, `Secure` (in prod), `Path=/api/v1/auth` cookie named `pe_refresh`. Web client relies exclusively on secure cookies.
- **Anti-Abuse & Anti-DoS**: Per-IP rate limiting (20 attempts per 15 min), account + IP pair lockout (5 failures locks offending IP only, preventing victim DoS).
- **Log Hygiene**: Zero plain secrets or passwords in logs; user emails and client IP addresses pseudonymized using HMAC-SHA256 (`AUTH_LOG_HMAC_SECRET`).

## 3. Data Privacy & DPDP Compliance
- **Child Protection**: Strict role-based isolation of students' and minors' personally identifiable information (PII).
- **Audit Logging**: Sensitive access, permission changes, and financial modifications tracked in immutable audit logs. No PII in logs.
