---
name: pe-queue-jobs
description: Guidance and standards for creating, scheduling, and processing asynchronous background jobs with BullMQ and Redis in ProgressEye API.
---
# ProgressEye Queue & Background Jobs Standard (BullMQ + Redis)

## 1. Asynchronous Architecture
Background tasks in ProgressEye (such as transactional email dispatch, webhook delivery, digest aggregation, and audit rollups) run asynchronously via **BullMQ** backed by **Redis**.

## 2. Core Operational Rules

### Rule 1: Zero PII in Job Payloads (Strict Data Minimisation)
- Job payloads MUST contain only primary entity IDs (e.g., `{ leadId: string }`).
- Never pass personal identifiable information (PII) such as names, email addresses, phone numbers, or freeform text into queue payloads or job metadata.
- Workers load the necessary entity data directly from PostgreSQL using `PrismaService` at execution time.

### Rule 2: HTTP Non-Blocking & Resilience
- Enqueueing operations must never fail the HTTP request. If Redis or BullMQ is temporarily unavailable, the enqueue error must be logged as a warning and fail gracefully without returning 500 to the client.

### Rule 3: Idempotency & Retries
- Background workers must be inherently idempotent. If a job is executed multiple times, it must verify the entity state before executing side effects (e.g., check `notified_at IS NULL` before sending emails).
- Standard retry configuration: 3 attempts with exponential backoff (`delay: 1000, type: "exponential"`).
- Remove completed jobs automatically (`removeOnComplete: true`) to avoid Redis memory bloat.

### Rule 4: PII-Free Worker Logging & Observability
- Worker logs must log structured events with job IDs and entity IDs only (`{ event: "lead_notification_sent", leadId, jobId }`).
- Subject lines and notification titles must remain strictly free of personal data (e.g. `"ProgressEye: new lead received (Ref: <short id>)"`).

### Rule 5: Standalone Worker Process Support
- Workers are designed to run embedded within the API server in single-instance deployments or executed via dedicated worker instances (`pnpm start:worker` / `src/worker.ts`) in horizontally scaled environments.
