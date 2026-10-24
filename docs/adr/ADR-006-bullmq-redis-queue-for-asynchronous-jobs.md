# ADR-006: BullMQ Redis Queue for Asynchronous Lead Notifications

## Status
Accepted

## Context
When public leads are submitted, the ProgressEye operations team must receive an email notification.
Directly dispatching transactional emails inside the HTTP request lifecycle has severe drawbacks:
1. **Latency**: SMTP handshakes introduce unpredictable latency (500ms - 5s) to the public web user.
2. **Reliability**: If the email server is temporarily down, the user request would fail even though their inquiry was successfully recorded.
3. **Privacy Risks**: Queuing engines often log raw job payloads. Storing personal data (names, emails, messages) in Redis creates an unnecessary second store of sensitive data.

## Decision

### 1. BullMQ with Redis
- We adopt **BullMQ** on Redis for background job management across ProgressEye.
- BullMQ provides native distributed locking, exponential backoff retries, and job status observability.

### 2. Zero-PII Payload Policy
- Queue job payloads contain **ONLY** `{ leadId: string }`.
- Background workers load the required lead record from PostgreSQL via `PrismaService` at execution time.
- Redis storage contains zero personal identifiable information (PII).

### 3. Asynchronous Worker Execution
- The worker executes idempotently: it checks `lead.notified_at IS NULL` before sending.
- Sends email via `SmtpEmailDeliveryService` (Mailpit locally, SES/Resend in production).
- Subject line is strictly PII-free: `ProgressEye: new lead received (Ref: <short id>)`.
- Updates `lead.notified_at = NOW()` upon successful dispatch.
- Configured with 3 retry attempts and exponential backoff.
- Failures in the queue or email transport never fail the HTTP request.

## Consequences
- Sub-50ms HTTP response times for public inquiries.
- Redis serves strictly as a job scheduling coordination layer without sensitive PII.
- Robust retries for email delivery failures without user disruption.
