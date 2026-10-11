---
description: Start a backend API phase by reviewing requirements, reading AGENTS.md and relevant engineering skills, and producing an implementation plan Artifact before stopping for approval.
---
# /phase-start Workflow (API)

When starting an API phase:
1. Read `AGENTS.md` and the current phase brief in `02-PHASES.md`.
2. Identify and read all relevant skills from `.agents/skills/`.
3. Check ADRs in `docs/adr/` and threat model in `docs/threat-model.md`.
4. Create an implementation plan Artifact including:
   - Target modules, controllers, services, repositories, and DTOs
   - Any database schema changes (RLS policies, expand-then-contract migration strategy)
   - New dependencies with explicit technical justification
   - Risk assessment (security, tenant isolation, concurrency)
   - Test plan (unit tests, RLS cross-tenant tests, e2e tests)
5. **STOP AND WAIT**: Do not write code or run migrations until the user reviews and explicitly approves the plan.
