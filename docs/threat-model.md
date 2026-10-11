# ProgressEye — Threat Model & Security Posture

## 1. Multi-Tenant Isolation
- **Row-Level Security (RLS)**: PostgreSQL RLS enforced on every tenant-scoped table via `school_id`.
- **Session Context**: The active `school_id` and user context are set on each pooled connection prior to executing transactions.
- **Cross-Tenant Prevention**: Zero trust between tenants. Every query must test and verify that data cannot leak across tenant boundaries.

## 2. Authentication & Session Management
- **Passwords**: Hashed with Argon2id using salt and high memory cost.
- **Tokens**: Short-lived access tokens (JWT, 15m), refresh tokens with automatic reuse detection and rotation stored securely with `HttpOnly`, `SameSite=Lax`, `Secure` flags.
- **Never Store in LocalStorage**: Web client relies exclusively on secure cookies.

## 3. Data Privacy & DPDP Compliance
- **Child Protection**: Strict role-based isolation of students' and minors' personally identifiable information (PII).
- **Audit Logging**: Sensitive access, permission changes, and financial modifications tracked in immutable audit logs. No PII in logs.
