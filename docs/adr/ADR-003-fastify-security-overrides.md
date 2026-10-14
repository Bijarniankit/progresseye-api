# ADR-003: Fastify Dependency Security Overrides

## Status
Accepted

## Context
Running `pnpm audit --prod --audit-level high` on `progresseye-api` revealed multiple high-severity vulnerabilities in transitive dependencies of `@nestjs/platform-fastify@11.2.7`:
1. **`@fastify/static <=10.1.0`**: [GHSA-83w8-p2f5-377r](https://github.com/advisories/GHSA-83w8-p2f5-377r) — Route guard bypass via path traversal vulnerability.
2. **`fastify <5.12.2`**:
   - [GHSA-p68q-wchp-6fh7](https://github.com/advisories/GHSA-p68q-wchp-6fh7) — Content-Type header validation bypass.
   - [GHSA-hwr6-493r-vm6h](https://github.com/advisories/GHSA-hwr6-493r-vm6h) — Request validation bypass via skipped boolean false schemas.
   - [GHSA-9q9j-q6p8-xq58](https://github.com/advisories/GHSA-9q9j-q6p8-xq58) — Header validation bypass via incomplete schema case normalization.

While `@nestjs/platform-fastify@11.2.7` declared a direct dependency on `fastify: 5.11.3`, Fastify 5 follows semantic versioning where patch versions (5.12.x) maintain full backwards compatibility with zero breaking API changes. Furthermore, `@nestjs/platform-fastify` specifies a peer dependency on `@fastify/static: ^10.1.2`.

## Decision
1. **Upgrade `@fastify/static`**: Explicitly upgrade `@fastify/static` in `package.json` to `^10.1.6` (resolving GHSA-83w8-p2f5-377r and fulfilling `@nestjs/platform-fastify`'s peer dependency).
2. **Enforce Fastify Override**: Specify `overrides: { fastify: ">=5.12.5" }` in `pnpm-workspace.yaml` (the standard override location for pnpm v11+), forcing both root and transitive `@nestjs/platform-fastify` to resolve to `fastify@5.12.5`.
3. **Configure Build Permissions (`allowBuilds`)**: In accordance with pnpm v11+ strict security defaults (`strictDepBuilds: true`), declare explicit build script allowances in `pnpm-workspace.yaml` for trusted packages (`@biomejs/biome`, `@prisma/client`, `@prisma/engines`, `argon2`, `prisma`) while disabling analytics/optional scripts (`@scarf/scarf`, `msgpackr-extract`).
4. **Remove Deprecated Manifest Field**: Remove obsolete `"pnpm"` configuration block from `package.json`.

## Consequences
### Positive
- All high-severity and critical advisories are resolved; CI dependency audit passes with 0 high/critical vulnerabilities.
- Full compatibility with `@nestjs/platform-fastify@11.2.7`; all existing unit tests, E2E tests, and compilation succeed.
- Clear, centralized dependency security governance in `pnpm-workspace.yaml`.

### Negative
- Requires maintaining the explicit override in `pnpm-workspace.yaml` until an upstream `@nestjs/platform-fastify` release increments its minimum Fastify dependency to `>=5.12.5`.
