---
name: pe-api-architecture
description: Use when designing or reviewing backend architecture, module boundaries, layering, and ADR compliance in ProgressEye API.
---
# ProgressEye API Architecture

## 1. Modular Monolith
The backend is structured as a modular monolith in NestJS 11. Modules are self-contained business units:
`academic`, `admissions`, `assessment`, `attendance`, `communication`, `documents`, `enrollment`, `finance`, `identity`, `learning`, `operations`, `people`, `platform`, `public`, `reporting`, `tenancy`.

## 2. Standard Layering within Modules
Each module adheres strictly to four internal layers:
- `http/`: Fastify controllers, route definitions, Swagger/OpenAPI decorators. Handles HTTP serialization and delegation.
- `application/`: Application services, use cases, orchestrators, event listeners. Contains business workflows.
- `domain/`: Pure domain models, entities, business invariants, value objects, domain error definitions. Independent of external frameworks.
- `infra/`: Database repositories, Prisma queries, external service integrations, caches, message queues.
- `dto/`: Request/response schemas and Zod contracts (`nestjs-zod`).
- `tests/`: Module unit and integration tests.

## 3. Cross-Module Boundaries
- Modules interact only through exported application services or asynchronous event queues.
- Modules never import another module's internal repositories or entities directly.
- The `public` module serves unauthenticated marketing endpoints (leads, contact, newsletter); its tables have no `school_id`.
- All tenant-aware modules enforce `school_id` RLS scoping on all data operations.

## 4. ADR Rule
Any architectural change (such as database engine shifts, table partitioning strategies, cross-cutting auth models) requires an approved Architecture Decision Record in `docs/adr/`.
