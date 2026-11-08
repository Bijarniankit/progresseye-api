# ProgressEye API — Central Registry of Placeholders & Unsourced Claims

> **Status**: Active Living Registry  
> **Rule**: Any unverified value, retention schedule, or external provider integration must be tracked here and marked with `TODO-REAL-DATA` until confirmed.

---

## 1. Compliance, Privacy & Data Retention Placeholders

| Item / Claim | Code / Config Location | Current Value | Classification | Blocks Public Launch | Target Resolution |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Lead Data Retention Period (`retention_until`)** | `prisma/schema.prisma` (`Lead.retentionUntil`) | `NULL` (Retention period undecided) | `DRAFT-NEEDS-LEGAL-REVIEW` (`TODO-REAL-DATA`) | **Yes** | Legal counsel and compliance review to establish statutory inquiry retention period (e.g. 90/180/365 days) under DPDP regulations before scheduling deletion job in Phase 10. |
| **Audit Log Retention Period** | `prisma/schema.prisma` (`AuditLog`) | `TODO-REAL-DATA` (Retention period undecided pending legal review) | `DRAFT-NEEDS-LEGAL-REVIEW` (`TODO-REAL-DATA`) | **No** (Phase 11 foundational schema) | Legal counsel and compliance review to establish statutory audit log retention period (e.g. 1 year, 3 years, 7 years) under DPDP and educational data protection regulations before implementing automated partition dropping/archival. |
| **Turnstile Production Secret Key** | `.env.example` (`TURNSTILE_SECRET_KEY`) | Test key `1x0000000000000000000000000000000AA` | Dev/Test Placeholder | **Yes** | Generate and configure official production Cloudflare Turnstile secret key in production environment secrets manager. |
| **Notification Recipient Mailbox** | `.env.example` (`LEAD_NOTIFICATION_RECIPIENT`) | `leads@progresseye.com` | Unregistered Mailbox Placeholder | **Yes** | Configure dedicated operational inbox / helpdesk routing for inbound institutional school inquiries once mailbox is provisioned. |
| **Reverse Proxy ACME Email** | `Caddyfile` (`email`) | `TODO-REAL-DATA-ACME-EMAIL` | Unregistered Placeholder (`TODO-REAL-DATA`) | **Yes** | Project owner to provide valid administrator email address for Let's Encrypt / ZeroSSL TLS certificate notifications. |
| **Transactional Email Provider (SES / Resend)** | `SmtpEmailDeliveryService` | Local Mailpit SMTP default (`localhost:1025`) | Development Default | **Yes** | Transition from local SMTP / Mailpit to production transactional email service (AWS SES or Resend) with verified DKIM/SPF domain records. |
| **HaveIBeenPwned (HIBP) Password Breach Lookup** | `src/modules/identity/domain/password.service.ts` (`AUTH_BREACHED_PASSWORD_CHECK_ENABLED`) | `false` (Disabled by default; uses k-anonymity 5-char SHA-1 prefix) | `DRAFT-NEEDS-LEGAL-REVIEW` (`TODO-REAL-DATA`) | **No** (Phase 12a optional defense) | Legal counsel and privacy review to confirm external transmission of 5-character SHA-1 password hash prefixes to Cloudflare/HIBP API aligns with enterprise tenant privacy agreements and DPDP compliance before enabling in production. |
| **Web /api Rewrite Set-Cookie Pass-Through** | Next.js `next.config.ts` (`/api/:path*`) & Staging Proxy | UNVERIFIED (`TODO-REAL-DATA-COOKIE-REWRITE`) | `DRAFT-NEEDS-STAGING-VERIFICATION` | **Yes** (Blocks staging login) | Staging smoke tests must verify that browser Set-Cookie response headers from `/api/v1/auth/login` and `/api/v1/auth/refresh` pass through Next.js reverse proxy rewrites without truncation or cross-origin drop. |


