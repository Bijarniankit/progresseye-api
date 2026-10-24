# ADR-004: Public Leads Data Minimisation and Intake Architecture

## Status
Accepted

## Context
ProgressEye's public marketing website features three inbound inquiry pathways:
1. General contact inquiries (`/contact`)
2. Institutional demo scheduling requests (`/demo`)
3. Product news and release updates (`/newsletter`)

These inquiries originate before an institution has an active tenant account or database partition. Storing them requires careful architectural separation to ensure:
- No leakage into tenant-scoped tables or row-level security (RLS) policies.
- Compliance with India's Digital Personal Data Protection Act, 2023 (DPDP Act) and international data minimization standards.
- Immutable consent recording (verbatim copy and timestamp).
- Strict elimination of Personally Identifiable Information (PII) from logs and unencrypted headers.

## Decision
1. **Platform-Level Schema (`public_leads`)**:
   - Leads are persisted in a dedicated platform table `public_leads` without a `school_id` foreign key and outside tenant Row-Level Security.
   - Lead types are categorized via `LeadType` enum (`CONTACT`, `DEMO`, `NEWSLETTER`).
   - Status transitions follow `LeadStatus` enum (`NEW`, `CONTACTED`, `ARCHIVED`).

2. **Statutory Data Minimisation**:
   - `/demo` intake is pruned to essential contact information: `name`, `email`, `schoolName`, and optional `notes` / `preferredTime`.
   - Non-essential fields (`phone`, `cityState`, `studentCapacity`) are eliminated from initial intake and deferred to post-inquiry scheduling.
   - `/contact` collects `name`, `email`, `schoolName`, and `message`.
   - `/newsletter` collects only `email`.

3. **Consent Accounting**:
   - Every submission must affirmatively provide consent (`consentGiven: true`).
   - The API records the exact consent notice text presented (`consent_text`) and the UTC submission timestamp (`consented_at`).
   - A retention boundary field (`retention_until`) is provisioned to support automated data lifecycle pruning once retention policies are legally formalized (`TODO-REAL-DATA`).

4. **Zero-PII Observability**:
   - Request bodies on public intake routes are redacted in Pino HTTP logging (`body.name`, `body.email`, `body.schoolName`, `body.message`, `body.turnstileToken`).
   - Structured log events emit only anonymized identifiers (`leadId`, `type`, `status`).

5. **Shared Validation & OpenAPI Contract**:
   - DTOs are defined using `nestjs-zod` and automatically reflected into the OpenAPI specification (`/api/v1/public/*`).
   - Input validation failures return RFC 9457 Problem Details (`application/problem+json`) with an `invalidParams` array.

## Consequences
### Positive
- Strict compliance with DPDP data minimization and consent verification principles.
- Tenant isolation is preserved; public leads cannot access or collide with institutional tenant boundaries.
- No PII is emitted to logging aggregation pipelines or error monitors.
- Full contract synchronization with the web frontend via Orval.

### Negative
- Administrative processing of leads requires platform-level staff tooling rather than school-level portal interfaces.
