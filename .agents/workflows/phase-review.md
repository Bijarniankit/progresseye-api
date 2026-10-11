---
description: Review a completed API phase by running verification checks, testing cross-tenant isolation, and generating a walkthrough Artifact.
---
# /phase-review Workflow (API)

When concluding an API phase:
1. Run lint, typecheck, tests, and build:
   - `pnpm lint`
   - `pnpm typecheck`
   - `pnpm test`
   - `pnpm test:e2e`
   - `pnpm build`
2. Verify tenant isolation:
   - All tenant queries include `school_id`
   - RLS policies verified against cross-tenant access attempts
3. Ensure OpenAPI document generated cleanly at `/api/v1/openapi.json`.
4. Summarize changes and check against the phase checklist in `02-PHASES.md`.
5. Produce a walkthrough Artifact and stop for user review and approval.
