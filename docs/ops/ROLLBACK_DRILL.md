# ProgressEye Staging Rollback Drill & Operational Procedure

> **Objective**: Operational rollback procedure on DigitalOcean App Platform and Git repository state. Note: Zero-downtime is not claimed as unproven until tested under continuous production load.

---

## 1. Rollback Trigger Criteria

Initiate a rollback immediately if any of the following occur following a deployment:
- HTTP 5xx error rate exceeds 1% over a 3-minute rolling window.
- Healthcheck endpoint `/api/v1/health/live` returns non-200 or times out.
- The 12-route smoke sweep (`node scripts/staging-smoke.mjs`) reports any route failures.
- Severe performance regression (LCP > 3.5s or CLS > 0.1 on core marketing pages).

---

## 2. DigitalOcean App Platform Deployment Rollback `[UNVERIFIED - requires live verification]`

DigitalOcean App Platform retains previous deployment images and permits rollbacks without rebuilding:

### Option A: Via DigitalOcean Cloud Console `[UNVERIFIED - requires live verification]`
1. Navigate to [DigitalOcean App Platform Console](https://cloud.digitalocean.com/apps).
2. Click on the affected app (`progresseye-web` or `progresseye-api`).
3. Click the **Activity** tab to view deployment history.
4. Locate the last known good deployment (marked with green checkmark).
5. Click **Actions** (`...`) next to that deployment and select **Rollback to this deployment**.
6. Monitor the deployment status until active.
- **Official Docs**: [DigitalOcean App Platform Rollbacks](https://docs.digitalocean.com/products/app-platform/how-to/manage-deployments/#roll-back-a-deployment)

### Option B: Via `doctl` CLI `[UNVERIFIED - requires live verification]`
```bash
# 1. List recent deployments to find last known good deployment ID
doctl apps list-deployments <APP_ID>

# 2. Trigger rollback to the previous deployment ID
doctl apps rollback <APP_ID> --deployment-id <LAST_GOOD_DEPLOYMENT_ID>

# 3. Monitor rollback status
doctl apps get-deployment <APP_ID> <ROLLBACK_DEPLOYMENT_ID>
```
- **Official Docs**: [DigitalOcean CLI doctl Reference](https://docs.digitalocean.com/reference/doctl/reference/apps/rollback/)

---

## 3. Database Schema Rollback Strategy (Prisma ORM 6)

> [!IMPORTANT]
> **Prisma ORM does NOT support `prisma migrate down`**.
> Official Prisma Documentation: [Prisma Generating Down Migrations](https://www.prisma.io/docs/orm/prisma-migrate/workflows/generating-down-migrations)

When a schema migration causes failure or data corruption, rollback MUST follow one of two strategies:

### Strategy 1: Forward-Fix Migration (Recommended for non-destructive schema changes)
1. Write a corrective schema change in `prisma/schema.prisma` that reverts the offending column, table, or constraint.
2. Generate and apply a new forward migration:
   ```bash
   pnpm exec prisma migrate dev --name revert_offending_change
   ```
3. Mark any failed migration status if required:
   ```bash
   pnpm exec prisma migrate resolve --rolled-back <OFFENDING_MIGRATION_NAME>
   ```
   Official Docs: [Prisma migrate resolve](https://www.prisma.io/docs/orm/reference/prisma-cli-reference#prisma-migrate-resolve)

### Strategy 2: Point-in-Time Recovery (PITR) or Backup Restore (For destructive data loss)
1. In the DigitalOcean Managed PostgreSQL Console, navigate to **Backends** > **Backups**.
2. Select **Restore to a new database cluster** using Point-in-Time Recovery (PITR) to a timestamp immediately preceding the migration.
3. Update `DATABASE_URL` in the App Platform environment variables to point to the restored cluster.
4. Official Docs: [DigitalOcean Managed Database Restores](https://docs.digitalocean.com/products/databases/postgresql/how-to/restore/)

---

## 4. Post-Rollback Verification & Smoke Sweep

Immediately after triggering rollback, execute the automated route sweep:
```bash
node scripts/staging-smoke.mjs https://staging.progresseye.in
```
Verify that all routes report `PASS`, security headers are active, and latency is within normal thresholds.

---

## 5. Git Repository State Synchronization

Once staging is restored:
1. Identify the regression commit on `main`.
2. Revert the commit cleanly:
   ```bash
   git checkout -b revert/incident-fix main
   git revert -m 1 <MERGE_COMMIT_SHA> # If merge commit
   # or
   git revert <COMMIT_SHA> # If standard commit
   git push origin revert/incident-fix
   ```
3. Open PR, verify CI, and obtain approval before merging.
