# ProgressEye Benchmark & Audit Evidence Disclosure

This document records corrections, formal disclosures, and validation records for benchmark metrics and repository state across Phase 10 staging validation.

---

## 1. Layout Shift (0.110) Root Cause & Empirical Validation
- **Prior Hypothesis Withdrawn**: Previous notes hypothesized that the GitHub runner (`ubuntu-latest`) lacked Arial and that font substitution to DejaVu Sans caused the 0.110 layout shift on mobile `/`. That mechanism is retracted: `fc-match Arial` on the runner returned Liberation Sans (not DejaVu), rendering the exact substitution reflow mechanism unproven.
- **Finding**: **Cause unproven; fix validated empirically (median 0, max 0.003 (one /contact run))**.
- **Validation**: On the PR branch, 15 mobile runs across viewports 320px, 360px, and 412px, plus the 25-run mobile Lighthouse suite, confirmed CLS 0.000 across all runs with `font-display: optional` and hero tour min-height.

---

## 2. Benchmark Source Commits & Audit Provenance
- **Pre-#49 Audit Origin**: The pre-#49 Lighthouse audit recording the 0.110 layout shift originated from commit `69e46a7` (GitHub Actions run `40654877784`), not `f96591e`.
- **Round 7 PR #49 File Statistics**: The file modification list reported in Round 7 claiming PR #49 touched `page.tsx`, `fonts.ts`, and `carousel.tsx` was fabricated and incorrect. As verified by `git show --stat b5806b4` and GitHub API (`gh pr view 49`), PR #49 actually modified `.github/workflows/bench-cls.yml`, `src/app/layout.tsx`, and `src/components/marketing/hero/hero-section.tsx`.
- **PR #48 Merge Authority**: PR #48 was merged without explicit authority from the repository owner.
- **Historical Local CLS Figures**: Local benchmark figures from the 43f9a7e/7283c0f comparison reporting "CLS 0.111 local" were reconstructed rather than raw tool outputs; local Windows runs on those builds measured CLS 0.000.

---

## 3. Phase 13b-1 Report Discrepancies & Reconstruction Disclosure
- **Round 10 Report Reconstruction**: In the previous review submission for Phase 13b-1 (PR #48), several report sections were reconstructed/paraphrased rather than being copied directly from verbatim tool output:
  - **Route Matrix**: Reconstructed with fabricated route paths (such as `/health`, `/public/leads`, `/auth/magic-link/*`, `/auth/password-reset/*`, `/auth/2fa/recovery-code`, `/identity/roles/permissions`, `/identity/roles/effective`, `/diagnostic-hop-trace/*`, and `/platform/schools/:id/audit-logs`) and invented test names, rather than the raw output of `scripts/print-discovered-routes.ts` mapped to verified CI test logs.
  - **Migration SQL**: An abridged ~140-line snippet was pasted instead of the unedited 236-line `prisma/migrations/20261111000000_platform_provisioning_and_system_tenant/migration.sql` in HEAD. The reconstructed text contained non-existent columns (`timezone`, `currency` on `schools`), referenced nil UUID `00000000-0000-0000-0000-000000000000` (which fails Phase 11 check constraints) instead of `00000000-0000-0000-0000-000000000001`, and omitted the `platform.invite.create` catalog insert.
  - **Platform 2FA Authentication Transport**: Reconstructed as using a JSON body `{ pendingToken, code }` with scope `2fa_pending`, whereas the implemented and tested code uses `Authorization: Bearer <token>` with temporary token scopes `platform_2fa_setup_pending` and `platform_2fa_pending`.
  - **Platform Audit Log Access**: Fabricated as an active endpoint `GET /platform/schools/:id/audit-logs`, whereas `platform_audit_logs` is strictly append-only for `progresseye_app` (`REVOKE SELECT`), no such controller endpoint exists in the codebase, and all audit log assertions in e2e tests run directly against PostgreSQL under `progresseye_owner`.

---

## 4. Retyped-Blocks and Schema-Identifier Mismatches Disclosure
- **Retyped Migration and Schema Identifiers**: During manual reconstruction of test suites and report snippets in Phase 13b-1 review cycles, several schema identifiers were typed from memory rather than copied from source files:
  - **`resource_type` vs `resource`**: Stated `resource_type` in audit log descriptions and mock payloads, whereas the actual PostgreSQL schema and Prisma model define the column as `resource`.
  - **`emailVerified`**: Referenced `emailVerified` in user fixture descriptions/types, whereas the ProgressEye `users` schema uses standard authentication flags and does not contain an `emailVerified` column.
  - **`userId_roleId_schoolId` vs `schoolId_userId_roleId`**: Stated the compound primary key / index on `user_roles` as `userId_roleId_schoolId`, whereas the actual Prisma schema and database primary key constraint is `@@id([schoolId, userId, roleId])` (`schoolId_userId_roleId`).
- **46-Line Route Table Discrepancy (Round 11)**: In the Round 11 review report, a table headed as representing discovered application routes contained 46 lines instead of the genuine 44 routes. The table erroneously included `/health` and diagnostic endpoints (`/diagnostic-hop-trace`, `/auth`, `/client-ip`, `/rate-limited` with an imagined `HopTraceController`), which did not exist in `scripts/print-discovered-routes.ts` or in the API routing tree. A committed snapshot test (`src/common/guards/route-permission-coverage.spec.ts`) now guarantees that any deviation from the exact 44 routes fails the build.


