---
description: Export and tag OpenAPI specification from NestJS Zod DTOs for client synchronization.
---
# /contract-sync Workflow (API)

1. Generate latest OpenAPI document from Zod DTOs:
   - `pnpm openapi:generate`
2. Validate spec conforms to OpenAPI 3.1 standards.
3. Save spec to `docs/openapi.json`.
4. Notify web repo team/workflow that a contract update is available for `pnpm gen:api`.
