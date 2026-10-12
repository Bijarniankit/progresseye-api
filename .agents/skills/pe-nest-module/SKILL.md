---
name: pe-nest-module
description: Use when scaffolding or modifying a NestJS module in ProgressEye API, including controller, service, repository, Zod DTOs, and policies.
---
# NestJS Module Scaffolding Standard

## 1. Directory Blueprint
When scaffolding `<module>`, create:
```
src/modules/<module>/
  <module>.module.ts
  http/
    <module>.controller.ts
  application/
    <module>.service.ts
  domain/
    <module>.entity.ts
  infra/
    <module>.repository.ts
  dto/
    create-<module>.dto.ts
    <module>-response.dto.ts
  tests/
    <module>.service.spec.ts
    <module>.controller.spec.ts
```

## 2. Zod Contracts & DTOs
- Define data contracts using Zod schemas via `nestjs-zod`.
- Export DTO classes using `createZodDto(Schema)`.
- Annotate fields with clear descriptions and examples for OpenAPI generation.

## 3. Repositories & Tenancy
- Repositories encapsulate Prisma queries.
- Tenant queries must automatically scope to `school_id` provided by the request context.
- Never write raw SQL outside repositories.

## 4. Error Mapping
- Throw domain or NestJS HttpExceptions (`NotFoundException`, `BadRequestException`, `ConflictException`).
- All exceptions are intercepted by `ProblemExceptionFilter` and formatted according to RFC 9457 `application/problem+json`.
