# ADR-005: Public Leads Anti-Abuse, Idempotency and Notification Architecture

## Status
Accepted

## Context
Phase 9 wires the public intake endpoints (`/api/v1/public/contact`, `/api/v1/public/demo`, `/api/v1/public/newsletter`) to accept inbound school inquiries and newsletter subscriptions without authentication.
Public exposure requires defense against automated spam, denial-of-service, duplicate submissions, and data privacy leaks:
1. **Spam & Bot Abuse**: Automated bot submissions submit garbage or malicious payloads.
2. **Double Submissions & Retries**: Poor mobile connections lead users or client networks to retry HTTP requests, resulting in duplicate database records and duplicate notification emails.
3. **High Volume / Denial of Service**: Unmetered access risks resource exhaustion.
4. **Data Privacy**: Storing raw client IPs or sending PII to third-party providers violates DPDP minimization principles.

## Decision

### 1. Multi-Layer Anti-Abuse
- **Invisible Honeypot**: Hidden `website_url` trap field in request schemas. If filled, the API returns a standard `201 Created` receipt with an opaque UUID without persisting any record or sending notifications. Bots receive zero signal that they have been detected.
- **Cloudflare Turnstile**: `TurnstileService` verifies tokens via Cloudflare's `siteverify` endpoint with fail-closed semantics (rejecting inquiries if verification fails or times out). To respect client privacy, client IP is never forwarded to Cloudflare. Documented test keys are supported for local and CI environments.
- **Strict Payload Constraints**: Schemas use `.strict()` to reject unannounced fields, normalize emails (lowercase/trim), strip non-printable ASCII control characters (`0x00-0x08`, `0x0B-0x0C`, `0x0E-0x1F`, `0x7F`), and enforce a 16 kB request body limit (returning RFC 9457 HTTP 413).

### 2. Idempotency Guard (Redis + Unique Constraint)
- Clients provide an `Idempotency-Key` UUID v4 header.
- **Redis 24h Cache**: Using Redis `SET ... EX 86400 NX`, the API handles in-flight concurrent duplicates.
  - Same key + identical payload returns cached `201 Created` receipt with response header `Idempotent-Replayed: true`.
  - Same key + altered payload returns RFC 9457 HTTP 422 Unprocessable Entity.
- **Database Unique Constraint**: Unique index on `public_leads.idempotency_key` guarantees permanent deduplication even if Redis cache expires.

### 3. Rate Limiting
- Built on `@nestjs/throttler` with Redis storage:
  - Contact and Demo: 5 requests per 15 minutes per IP.
  - Newsletter: 10 requests per 15 minutes per IP.
  - Rejection: RFC 9457 HTTP 429 Too Many Requests with `Retry-After: 900`.

### 4. Client IP Protection
- Client IPs are hashed using HMAC SHA-256 with an environment secret (`LEAD_IP_HMAC_SECRET`).
- Raw client IPs are never written to disk or database tables, preventing precomputed dictionary attacks.

## Consequences
- Clean, tamper-evident lead intake with zero duplicate processing.
- Client applications can safely retry failed network requests with the same `Idempotency-Key`.
- Third-party dependency on Cloudflare Turnstile is isolated behind `ISpamVerificationService` interface and test keys.
