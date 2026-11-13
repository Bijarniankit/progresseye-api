# Phase 6 Technical & Maintenance Backlog

Deferred maintenance chores and dependency upgrades scheduled for execution at the start of Phase 6:

1. **pnpm packageManager**: Unify pnpm version in `package.json` (`packageManager: pnpm@12.11.2`), commit updated `pnpm-lock.yaml` with `packageManagerDependencies`, and remove hardcoded `version:` in CI `pnpm/action-setup` (PR #10 opened).
2. **dependabot.yml**: Add grouped weekly minor/patch updates and ignore semver-major bumps for core framework/tooling packages across both repositories (PR in progress).
3. **Actions v7 upgrades**: Bump and cryptographically pin `actions/checkout@v7.0.1`, `actions/setup-node@v7.1.0`, and `actions/upload-artifact@v7.0.2` in both workflow files (Completed: web PRs #1–#3 merged, api PRs #1–#3 merged).
4. **@types/node 24**: Upgrade `@types/node` in `progresseye-web` to `^24.x.x` matching the Node 24 runtime used in CI, `.nvmrc`, and Docker (closed Dependabot PR #7 for major v26; major ignored in `dependabot.yml`).
5. **Prisma 7**: Upgrade `prisma` CLI and `@prisma/client` from 6.19.3 to 7.x.x in `progresseye-api` in an isolated PR with migration verification (closed Dependabot PR #8; major ignored in `dependabot.yml`).
6. **TypeScript 6**: Upgrade `typescript` to 6.x in `progresseye-api` once compatible across NestJS and tooling (closed Dependabot PR #4; major ignored in `dependabot.yml`).
7. **Jest 30**: Upgrade `jest` and `@types/jest` to 30.x in `progresseye-api` once ts-jest / NestJS testing ecosystem stabilizes (closed Dependabot PR #7; major ignored in `dependabot.yml`).
8. **git identity**: Configure official `user.name` and `user.email` locally across both repositories per owner specification.
9. **branch protection**: Verify and enforce GitHub branch protection rules (`Linux Verification (ubuntu-latest)`, branch up to date, no force push/deletions) on `main` for both repos.

---

## Phase 10: Launch Readiness & Deployment Checklist

### 1. Trusted Proxy Reverse Proxy Configuration
- **Context**: Fastify is configured with `trustProxy: true` in `src/main.ts` to extract the true client IP from `X-Forwarded-For` headers.
- **Checklist Item**: When deploying to staging and production behind cloud load balancers (AWS ALB, Cloudflare edge, or Kubernetes Ingress / Traefik):
  - Ensure edge proxy strips untrusted client-supplied `X-Forwarded-For` headers before appending client IP.
  - Verify `X-Forwarded-Proto: https` is forwarded to ensure SSL redirection.
  - Verify rate limiter and HMAC IP hashing evaluate the true client IP.

### 2. Lead Data Retention Pruning Worker (`retention_until`)
- **Context**: The `retention_until` column is provisioned on `public_leads` table, but automated deletion is deliberately deferred pending legal sign-off.
- **Checklist Item**: Once legal counsel defines the statutory retention window under DPDP:
  - Implement a daily scheduled BullMQ queue job (`lead-retention-pruner`) to delete records where `retention_until < NOW()`.

### 3. Production Cloudflare Turnstile Configuration
- **Checklist Item**: Configure real Cloudflare Turnstile site key and secret key in production environment secrets; enable `TURNSTILE_ENABLED=true`.

### 4. Production Email Transport (AWS SES / Resend)
- **Checklist Item**: Replace local SMTP / Mailpit default with managed transactional email transport with SPF/DKIM verification.

### 5. Newsletter Double Opt-In Workflow
- **Checklist Item**: Implement double opt-in confirmation email token dispatch and verification endpoint for newsletter subscribers.

### 6. Audit Log Monthly Partition Provisioning & Maintenance Job
- **Context**: The `audit_logs` table is partitioned by month (`PARTITION BY RANGE (created_at)`).
- **Checklist Item**:
  - Implement a monthly scheduled BullMQ cron worker (`audit-partition-maintainer`) that verifies and pre-provisions child partition tables 2 months in advance (e.g. `CREATE TABLE IF NOT EXISTS audit_logs_yYYYYmMM PARTITION OF audit_logs FOR VALUES FROM (...) TO (...)`).
  - Automatically apply `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, and policy grants on newly created child partitions.
  - Implement partition archival/dropping according to the statutory data retention policy once defined by legal review (`TODO-REAL-DATA` in `PLACEHOLDERS.md`).
  - **Default Partition Caveat (Detach / Move / Attach Procedure)**: In PostgreSQL, if rows for a target month have landed in the catch-all partition (`audit_logs_default`), directly creating or attaching that month's partition will fail with `ERROR: updated partition constraint for default partition "audit_logs_default" would be violated by some row`. The maintenance job must execute the following detach/move/attach sequence:
    1. Detach default partition: `ALTER TABLE audit_logs DETACH PARTITION audit_logs_default;`
    2. Move matching rows: `INSERT INTO audit_logs_yYYYYmMM SELECT * FROM audit_logs_default WHERE created_at >= 'YYYY-MM-01' AND created_at < 'YYYY-NEXT_MM-01';` followed by `DELETE FROM audit_logs_default WHERE created_at >= 'YYYY-MM-01' AND created_at < 'YYYY-NEXT_MM-01';`
    3. Attach new partition: `ALTER TABLE audit_logs ATTACH PARTITION audit_logs_yYYYYmMM FOR VALUES FROM ('YYYY-MM-01') TO ('YYYY-NEXT_MM-01');`
    4. Re-attach default partition: `ALTER TABLE audit_logs ATTACH PARTITION audit_logs_default DEFAULT;`

### 7. Provisioning Platform-Level Audit Log Sink (`platform_audit_logs`)
- **Context**: In Phase 11, `audit_logs` is strictly tenant-scoped with `school_id NOT NULL` and RLS enforced. Platform-level audit events (such as tenant provisioning, global administrative operations, and public lead submissions) cannot be stored in `audit_logs` without bypassing or weakening RLS.
- **Checklist Item**:
  - Provision a dedicated `platform_audit_logs` table (or external structured audit log sink) owned by the platform schema without tenant RLS constraints.
  - Implement platform audit logging service to capture tenant provisioning and cross-tenant platform events.

### 8. Validate `withTenant` schoolId against Request Tenant Context
- **Context**: `withTenant` currently validates that `schoolId` is a non-nil valid UUID. In HTTP request lifecycles where a tenant context is already active, callers should be restricted from passing an arbitrary `schoolId` that differs from the active request context unless explicitly marked as platform-initiated (e.g. platform admin impersonation or internal provisioning task).
- **Checklist Item**: Enhance `withTenant` to verify that when an active request tenant context is present, the target `schoolId` matches the request tenant ID unless an explicit platform bypass flag is provided.

### 9. Strongly Type `PrismaService._tenantClient`
- **Context**: `PrismaService._tenantClient` is currently typed as `any` because dynamic Prisma Client extension return types (`$extends`) are deeply nested and parameterized.
- **Checklist Item**: Define a precise return type alias or derive via Prisma client return types to eliminate the `any` type on `_tenantClient`.

### 10. Provision Staging and Production Role Passwords via AWS SSM / Secrets Manager
- **Context**: Database role passwords for `progresseye_app`, `progresseye_ro`, and `progresseye_owner` are excluded from migrations and repository tracking. CI uses throwaway workflow environment variables.
- **Checklist Item**: In staging and production environments, retrieve database role credentials from AWS Systems Manager (SSM) Parameter Store or AWS Secrets Manager. Execute `ALTER ROLE ... WITH PASSWORD` after `prisma migrate deploy` completes. Incorporate this step into the owner deployment checklist.

### 11. Durable Database Sink for Platform-Level IP-Block and Security Events
- **Context**: In Phase 12a, IP-level rate-limiting and anti-abuse blocks are emitted to Pino structured logs using HMAC-pseudonymized IP hashes. Because `audit_logs` requires a non-null `school_id` and is strictly partitioned by tenant under PostgreSQL RLS, IP-block events currently have no durable database record.
- **Checklist Item**: Once `platform_audit_logs` (Item 7) is provisioned, route global IP-block events, anonymous brute-force telemetry, and cross-tenant security alerts into `platform_audit_logs` alongside Pino structured logs.

### 12. Web /api Rewrite and Set-Cookie Header Pass-Through Verification
- **Status**: UNVERIFIED for staging (`TODO-REAL-DATA-COOKIE-REWRITE`).
- **Context**: Under the single-origin architecture, the web frontend proxies API requests via a `/api` rewrite (`https://staging.progresseye.com/api/*` -> backend API). In Phase 12a, refresh tokens are set via `Set-Cookie: pe_refresh_token=...; Path=/api/v1/auth; HttpOnly; SameSite=Lax`.
- **Checklist Item**: During staging deployment smoke tests, verify that Next.js reverse proxy rewrites forward the upstream `Set-Cookie` response headers back to the browser client and that subsequent browser requests to `/api/v1/auth/refresh` correctly relay the `Cookie` header upstream to the API server without stripping or domain mismatches.

### 13. Replace Substring Pattern Matching for Weak Keys with Entropy and Diversity Check
- **Context**: In Phase 12a, `src/config/env.schema.ts` checks production secrets (`AUTH_JWT_SECRET`, `AUTH_GRACE_ENC_KEY`, `AUTH_LOG_HMAC_SECRET`) using minimum length guards and a blacklist of substring patterns (e.g. `'dev-jwt-secret'`, `'default'`, `'secret'`, `'123456'`).
- **Rationale**: Substring pattern matching is inherently brittle, easily bypassed by minor permutations (e.g. `'s3cret'`, `'dev_jwt_secret'`), and provides a false sense of security.
- **Checklist Item**: Replace substring blacklist checks with a formal Shannon entropy metric (e.g. minimum 3.5 bits/char) or cryptographic character-set diversity and minimum random byte validation (e.g. min 32 hex/base64 random characters, rejected if low-entropy character repetitions are detected).

### 14. Scheduled Cleanup Cron Job for Expired Account Lifecycle Tokens
- **Context**: In Phase 12b-1, `password_reset_tokens` (1h TTL) and `email_verification_tokens` (24h TTL) store single-use lifecycle tokens. When users request new tokens or redeem existing ones, previous tokens are marked with `used_at = CURRENT_TIMESTAMP(3)`. Over time, expired and consumed rows accumulate in these tables.
- **Checklist Item**:
  - Implement a daily scheduled BullMQ cron worker (`auth-token-pruner`) that executes:
    `DELETE FROM password_reset_tokens WHERE (expires_at < NOW() - INTERVAL '7 days') OR (used_at IS NOT NULL AND used_at < NOW() - INTERVAL '7 days');`
    `DELETE FROM email_verification_tokens WHERE (expires_at < NOW() - INTERVAL '7 days') OR (used_at IS NOT NULL AND used_at < NOW() - INTERVAL '7 days');`
  - Ensure the pruner operates under appropriate maintenance roles (`progresseye_owner`) or tenant-scoped batches to prune safely without table lock contention.
  - **Note on Permissions**: The purge job does not exist yet. In Phase 12b-1, `progresseye_app` is granted `SELECT, INSERT, UPDATE` only. When this purge job is implemented, grant `DELETE` on `password_reset_tokens` and `email_verification_tokens` to the designated maintenance/app role in that migration.

### 15. Web Reset and Email Verification URL Fragment Handling (Phase 14)
- **Context**: In Phase 12b-1, account lifecycle links place tokens exclusively in the URL fragment (`/auth/reset-password#token=<compoundToken>` and `/auth/verify-email#token=<compoundToken>`), preventing token leakage into HTTP `Referer` headers, server access logs, or browser navigation history.
- **Requirement for Web (Phase 14)**: The frontend pages for password reset and email verification must parse the token exclusively from `window.location.hash`, include it in the POST request body (`POST /api/v1/auth/reset-password` and `POST /api/v1/auth/verify-email`), and never log the token to browser console or telemetry sinks.

### 16. Post-Verification or IP-Scoped 2FA Attempt Counter
- **Context**: In Phase 12b-2, `checkAndIncrementAttemptCap` increments the per-user attempt counter (`auth:2fa:attempts:<userId>`) pre-verification before evaluating the TOTP code or recovery code.
- **Risk**: An attacker who intercepts or holds a victim's temporary `2fa_pending` token could deliberately submit 5 bogus verification requests to exhaust the victim's attempt budget, causing a 15-minute temporary lockout (Denial of Service).
- **Checklist Item**:
  - Update the 2FA verification flow to record and increment attempts only upon verification failure (post-verification increment) rather than pre-verification, or partition attempt tracking with an IP dimension (`auth:2fa:attempts:<userId>:<ipHash>`).
  - Ensure brute-force resistance remains airtight while completely eliminating the risk of a malicious actor burning a victim's attempt budget using an acquired `2fa_pending` token.

### 17. Permission Cache Invalidation Race Between Pre-Commit Eviction and Transaction Commit
- **Context**: In Phase 13a, `evictUser` and `evictUsers` run inside the `withTenant` transaction callback before commit. If an eviction failure occurs, the database transaction rolls back, preventing stale cache on Redis failures. However, an interleaving read arriving immediately after eviction but before PostgreSQL transaction commit could re-cache pre-update permissions from the database.
- **Checklist Item**:
  - Implement a dual-eviction strategy (evicting pre-commit to detect Redis failures and again post-commit via transactional event/hook), or transition to a versioned tenant permission cache key (e.g. `auth:perm:<schoolId>:<userId>:<permVersion>` where the user's `permission_version` counter is atomically bumped in PostgreSQL upon role assignment/mutation).

### 18. Explicit 503 Service Unavailable on Cache Eviction Failure
- **Context**: In Phase 13a, when Redis is unavailable or eviction fails during a role mutation (`assignRole`, `unassignRole`, `updateRole`, `deleteRole`, `deactivateUser`), `PermissionCacheService` throws an `Error`, causing the transaction to abort and the exception filter to return HTTP 500 `InternalServerErrorException`.
- **Checklist Item**:
  - Wrap cache eviction failures or catch `RedisUnavailableException` / cache errors in the mutation flow and map them to HTTP 503 `ServiceUnavailableException` with an explicit problem detail error code (e.g. `SERVICE_UNAVAILABLE` / `CACHE_EVICTION_FAILED`).
  - Provide a clear message to clients indicating that upstream caching infrastructure is temporarily unavailable and that the mutation was aborted safely without modifying database state.

### 19. Platform Audit-Log Viewer Service & Read-Only Connection (Phase 14)
- **Context**: In Phase 13b-1, `platform_audit_logs` is provisioned as a global append-only sink where the operational database role `progresseye_app` has `GRANT INSERT` only and explicit `REVOKE SELECT, UPDATE, DELETE, TRUNCATE`. This prevents tampering and compromises of application workers from reading or modifying the platform audit trail.
- **Checklist Item**:
  - Implement a dedicated platform audit-log reader service in Phase 14 that connects via a read-only database credential (`progresseye_ro` or elevated administrative connection).
  - Provide a paginated, filterable endpoint (`GET /api/v1/platform/audit-logs`) protected by `PlatformGuard` and requiring `platform.audit.read` permission.
  - Implement field-level masking and temporal range filtering to support institutional security audits and regulatory compliance.

### 20. Investigate and Remove "forceExit": true in test/jest-e2e.json
- **Context**: In Phase 13b-1, `"forceExit": true` was added to `test/jest-e2e.json` to prevent Jest test runner process hangs after all 194 e2e tests complete.
- **Checklist Item**:
  - Run the e2e test suite with `jest --detectOpenHandles` to identify asynchronous resources or handles preventing clean Node.js process exit.
  - Audit and ensure all Fastify HTTP servers, Prisma client instances, and Redis connections (ioredis) in test setups and teardowns are closed explicitly in `afterAll` hooks (`server.closeAllConnections()`, `app.close()`, `prisma.$disconnect()`, `redis.quit()`).
  - Once all open handles are cleanly terminated across all e2e suites, remove `"forceExit": true` from `test/jest-e2e.json`.

### 21. Refusal of system-platform Slug on Tenant Authentication Endpoints (Phase 13b-2 Priority)
- **Context**: In Phase 13b-1, platform administrators reside in the system tenant (`00000000-0000-0000-0000-000000000001`, slug `system-platform`) and authenticate exclusively via `/api/v1/platform/auth/*` routes.
- **Checklist Item (To be completed first in Phase 13b-2)**:
  - Update tenant authentication endpoints (`POST /api/v1/auth/login`, `POST /api/v1/auth/forgot-password`, `POST /api/v1/auth/verify-email`, `POST /api/v1/auth/resend-verification`) to reject any request specifying the `system-platform` school slug.
  - Return generic responses (e.g. 401 Unauthorized for login, generic success messages for password reset / verification to prevent slug enumeration) and ensure no access or refresh tokens are ever issued for the system tenant through tenant auth endpoints.
  - Add comprehensive e2e tests asserting that requests against tenant auth routes with `schoolSlug: "system-platform"` are consistently rejected.

### 22. Soft-Deleted Admin E2E Test State Restoration in finally Block
- **Context**: In Phase 13b-1, an e2e test was added in `test/e2e/platform-provisioning.e2e-spec.ts` asserting that soft-deleted platform administrators receive HTTP 401 Unauthorized.
- **Checklist Item**:
  - Wrap the database state mutation (`deletedAt: new Date()`) and subsequent assertions in a `try...finally` block (or handle cleanup in `afterEach`) to ensure `deletedAt` is unconditionally restored to `null` even if intermediate test assertions fail or throw unexpected errors.









