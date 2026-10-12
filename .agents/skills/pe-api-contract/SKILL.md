---
name: pe-api-contract
description: Use when creating or modifying API contracts, OpenAPI specs, Zod DTOs, or synchronizing with progresseye-web via Orval.
---
# API Contract Synchronization Standard

## 1. Single Source of Truth
- The NestJS API defines the single source of truth for all API contracts using Zod schemas (`nestjs-zod`) and `@nestjs/swagger`.
- Endpoints are served under the global prefix `/api/v1`.
- Raw OpenAPI JSON specification is exported to `/api/v1/openapi.json` and saved to `openapi/openapi.json` at build time.

## 2. Synchronization with Web
- `progresseye-web` does not query the API directly at build time.
- The web repository synchronizes by consuming the pinned OpenAPI specification using Orval (`pnpm gen:api`).
- Generated client code (TanStack Query hooks, request/response models) resides in `progresseye-web/src/lib/api/generated/` and is committed.

## 3. Versioning & Evolution
- Breaking changes are forbidden on active endpoints.
- Apply the Expand-and-Contract migration pattern:
  1. Expand: Introduce new nullable fields or new route versions (`/api/v2/*`).
  2. Transition: Update consumers to adopt the new schema.
  3. Contract: Deprecate and safely remove legacy fields after full consumer rollout.
