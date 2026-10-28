# ProgressEye API — Central Registry of Placeholders & Unsourced Claims

> **Status**: Active Living Registry  
> **Rule**: Any unverified value, retention schedule, or external provider integration must be tracked here and marked with `TODO-REAL-DATA` until confirmed.

---

## 1. Compliance, Privacy & Data Retention Placeholders

| Item / Claim | Code / Config Location | Current Value | Classification | Blocks Public Launch | Target Resolution |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Lead Data Retention Period (`retention_until`)** | `prisma/schema.prisma` (`Lead.retentionUntil`) | `NULL` (Retention period undecided) | `DRAFT-NEEDS-LEGAL-REVIEW` (`TODO-REAL-DATA`) | **Yes** | Legal counsel and compliance review to establish statutory inquiry retention period (e.g. 90/180/365 days) under DPDP regulations before scheduling deletion job in Phase 10. |
| **Turnstile Production Secret Key** | `.env.example` (`TURNSTILE_SECRET_KEY`) | Test key `1x0000000000000000000000000000000AA` | Dev/Test Placeholder | **Yes** | Generate and configure official production Cloudflare Turnstile secret key in production environment secrets manager. |
| **Notification Recipient Mailbox** | `.env.example` (`LEAD_NOTIFICATION_RECIPIENT`) | `leads@progresseye.in` | Unregistered Mailbox Placeholder | **Yes** | Configure dedicated operational inbox / helpdesk routing for inbound institutional school inquiries once mailbox is provisioned. |
| **Transactional Email Provider (SES / Resend)** | `SmtpEmailDeliveryService` | Local Mailpit SMTP default (`localhost:1025`) | Development Default | **Yes** | Transition from local SMTP / Mailpit to production transactional email service (AWS SES or Resend) with verified DKIM/SPF domain records. |
