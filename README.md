# ProgressEye API (`progresseye-api`)

Backend API service for ProgressEye 2.0 multi-tenant school operating system.

## Tech Stack
- **Framework**: NestJS 11 on Fastify HTTP adapter
- **Database & ORM**: Supabase PostgreSQL / PostgreSQL 17 with Row-Level Security (RLS) & Prisma
- **Background Jobs**: BullMQ on Redis
- **Validation & Spec**: Zod (`nestjs-zod`) & OpenAPI 3.1 (`@nestjs/swagger`) with Scalar UI
- **Logging**: `nestjs-pino` (structured JSON with request ID tracking & data redaction)
- **Security**: Fastify Helmet, strict CORS, and `@nestjs/throttler`
- **Errors**: RFC 9457 `application/problem+json` global exception handling
- **Linter & Formatter**: Biome
- **Package Manager**: pnpm

## Getting Started

### Prerequisites
- Node.js `24.x` (see `.nvmrc`)
- pnpm `12.x`
- Supabase project connection string or Docker Compose (PostgreSQL 17, Redis, Mailpit, MinIO)

### Setup & Local Services
```bash
# Start local infrastructure (if running offline without Supabase Cloud)
docker compose up -d

# Install dependencies
pnpm install

# Configure environment variables (Supabase or local Postgres)
cp .env.example .env

# Generate Prisma client and migrate
pnpm prisma:generate
pnpm prisma:migrate
```

## Available Commands

| Command | Description |
|---|---|
| `pnpm dev` | Start Fastify HTTP server in watch mode (`http://localhost:4000/api/v1`) |
| `pnpm dev:worker` | Start BullMQ worker process in development mode |
| `pnpm start:prod` | Run compiled production HTTP server |
| `pnpm start:worker` | Run compiled production BullMQ worker |
| `pnpm build` | Compile TypeScript codebase with NestJS CLI |
| `pnpm lint` | Run code quality checks with Biome |
| `pnpm lint:fix` | Fix formatting and lint issues automatically with Biome |
| `pnpm format` | Format code with Biome |
| `pnpm typecheck` | Strict TypeScript type checking without emitting files |
| `pnpm test` | Run unit test suites |
| `pnpm test:e2e` | Run end-to-end and health check test suites |
| `pnpm prisma:migrate` | Run database migrations |
| `pnpm prisma:seed` | Seed database with initial platform records |
| `pnpm openapi:generate` | Generate pinned `openapi/openapi.json` contract for web client |

## Endpoints & Documentation
- **Interactive Documentation**: `http://localhost:4000/docs` (Scalar UI)
- **OpenAPI Specification**: `http://localhost:4000/api/v1/openapi.json`
- **Liveness Probe**: `GET /api/v1/health/live`
- **Readiness Probe**: `GET /api/v1/health/ready` (checks Database & Redis)

## Architecture & Tenancy
- **RLS Isolation**: Every tenant table requires `school_id` and RLS policy enforcement.
- **Contract First**: OpenAPI document served at `/api/v1/openapi.json` powers `progresseye-web` client generation via Orval.
- **Money Handling**: All currency calculations and storage strictly use integer paise.
- **RFC 9457 Errors**: All HTTP errors return standard `application/problem+json`.
