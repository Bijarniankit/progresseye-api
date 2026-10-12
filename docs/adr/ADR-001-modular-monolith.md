# ADR-001: Modular Monolith Architecture

## Status
Accepted

## Context
ProgressEye 2.0 is a comprehensive multi-tenant school management ERP platform spanning 16 distinct domain areas (Academic, Admissions, Assessment, Attendance, Communication, Documents, Enrollment, Finance, Identity, Learning, Operations, People, Platform, Public, Reporting, Tenancy). 

Microservice architectures introduce high operational complexity, distributed transaction overhead, network latency, and deployment friction for single-tenant or multi-tenant school operations at this stage.

## Decision
We adopt a **Modular Monolith** architecture built on NestJS 11 and Fastify:
- A single deployable codebase running all modules.
- Strict module boundaries with 4-layer internal separation (`http`, `application`, `domain`, `infra`).
- No direct database access or cross-module domain leakage; modules communicate via exported application services or asynchronous BullMQ queues.
- Unified transaction management through Prisma.

## Consequences
### Positive
- Simplicity of development, debugging, and testing in a single repository.
- Single database schema simplifies transactions and cross-domain reports.
- Fast execution and low operational costs.
- Clear module boundaries make future extraction into independent microservices straightforward if scale requires.

### Negative
- Code hygiene and linting must strictly enforce module boundaries to prevent accidental tight coupling.
