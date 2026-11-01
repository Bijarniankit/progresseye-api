# ProgressEye Staging Owner Checklist

> **Canonical Source of Truth**: [`progresseye-web/docs/ops/STAGING_OWNER_CHECKLIST.md`](https://github.com/Bijarniankit/progresseye-web/blob/main/docs/ops/STAGING_OWNER_CHECKLIST.md)

The end-to-end staging deployment checklist for the single-server AWS EC2 Docker Compose topology (Caddy, Next.js Web, NestJS API, BullMQ Worker, Redis, and Amazon RDS PostgreSQL 17 in `ap-south-1` Mumbai) is maintained canonically in the `progresseye-web` repository to eliminate duplication and drift:

- **Full AWS Staging Owner Checklist**: [progresseye-web: `docs/ops/STAGING_OWNER_CHECKLIST.md`](https://github.com/Bijarniankit/progresseye-web/blob/main/docs/ops/STAGING_OWNER_CHECKLIST.md)
- **Staging Rollback Drill**: [`docs/ops/ROLLBACK_DRILL.md`](./ROLLBACK_DRILL.md)
- **API Environment Variables Reference**: [`.env.example`](../../.env.example) and [`docs/design/PLACEHOLDERS.md`](../design/PLACEHOLDERS.md)
