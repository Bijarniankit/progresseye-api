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

