# ProgressEye Staging Rollback Drill & Operational Procedure

> **Objective**: Operational rollback procedure for the single-server AWS EC2 Docker Compose topology (Caddy, Next.js Web, NestJS API, BullMQ Worker, Redis) and Amazon RDS PostgreSQL 17.  
> **Topology Note**: Single-server deployment does not offer High Availability (HA). Zero-downtime is explicitly **not claimed**; container redeployment or restart produces a momentary disruption.

---

## 1. Single-Server Deployment Risks & Minimum Mitigations

| Risk | Consequence | Minimum Operational Mitigation |
|---|---|---|
| **No High Availability (Single Instance)** | If the EC2 instance halts, crashes, or encounters underlying AWS hardware degradation, all services (Web, API, Worker, Redis, Ingress) go offline simultaneously. | 1. **RDS Separation**: Database runs on AWS Managed RDS PostgreSQL 17 independent of EC2 host.<br>2. **Automated EBS Snapshots**: Configured via AWS Data Lifecycle Manager (DLM) daily.<br>3. **External Uptime Monitor**: 60-second polling with immediate SMS/push alerting (Better Stack / UptimeRobot). |
| **OS Security Patching & Kernel Updates** | Applying Linux OS security updates (e.g. `dnf update` / `apt upgrade`) often necessitates instance reboots. | 1. **Scheduled Maintenance Window**: Execute patching strictly during pre-notified off-hours.<br>2. **Pre-reboot Health Validation**: Verify container health before and after restart.<br>3. **Fast Reboot**: AWS Nitro-based instances (`t3`/`t4g`) reboot in ~30–45 seconds. |
| **Container Restart on Deployment** | Rebuilding or restarting Docker containers (`docker compose up -d`) momentarily terminates listening sockets before new containers pass health checks. | 1. **Docker `restart: unless-stopped`**: Automatic container recovery on failure.<br>2. **Staged Service Restarts**: Restart worker and API before Web container.<br>3. **Caddy Reverse Proxy Buffer**: Caddy holds incoming connections briefly during upstream port rebind. |
| **Resource Contention (CPU/RAM)** | Memory spikes in Next.js SSR or BullMQ worker could trigger Linux Out-Of-Memory (OOM) killer on Redis or API. | 1. **Swap File**: Configure 2–4 GB swap space on root EBS volume.<br>2. **Redis Memory Capping**: Redis configured with `--maxmemory 256mb --maxmemory-policy noeviction`.<br>3. **CloudWatch Metrics**: Alarms on EC2 Memory/CPU utilization > 80%. |

---

## 2. Rollback Trigger Criteria

Initiate a rollback immediately if any of the following occur following a deployment:
- HTTP 5xx error rate exceeds 1% over a 3-minute rolling window.
- Healthcheck endpoint `/api/v1/health/live` returns non-200 or times out.
- The 12-route smoke sweep (`node scripts/staging-smoke.mjs`) reports any route failures.
- Severe performance regression (LCP > 3.5s or CLS > 0.1 on core marketing pages).

---

## 3. Docker Compose Application Rollback (Single EC2 Host) `[UNVERIFIED - requires live verification]`

In the single-server topology on AWS EC2, rollbacks are performed directly via Docker Compose on the host instance:

### Option A: Rolling Back via Previous Git Commit Tag `[UNVERIFIED - requires live verification]`
1. Connect to the EC2 instance via AWS Systems Manager (SSM) Session Manager or SSH:
   ```bash
   aws ssm start-session --target <EC2_INSTANCE_ID> --region ap-south-1
   ```
2. Navigate to the application deployment directory:
   ```bash
   cd /opt/progresseye
   ```
3. Checkout the last known good commit or release tag:
   ```bash
   git fetch origin
   git checkout <LAST_KNOWN_GOOD_SHA>
   ```
4. Rebuild and restart the containers with zero stale artifacts:
   ```bash
   docker compose -f docker-compose.staging.yml up -d --build
   ```
5. Inspect container health and live startup logs:
   ```bash
   docker compose -f docker-compose.staging.yml ps
   docker compose -f docker-compose.staging.yml logs --tail=100 -f api web
   ```
- **Official Docs**: [Docker Compose CLI Reference](https://docs.docker.com/reference/cli/docker/compose/)

### Option B: Rolling Back via Pinned Docker Image Registry Tags `[UNVERIFIED - requires live verification]`
If images are pushed to Amazon Elastic Container Registry (ECR):
1. Update image tags in `.env` or `docker-compose.staging.yml` from `:latest` to the previous specific build tag (e.g. `:sha-<PREVIOUS_SHA>`).
2. Pull the targeted images and restart services:
   ```bash
   docker compose -f docker-compose.staging.yml pull
   docker compose -f docker-compose.staging.yml up -d
   ```
- **Official Docs**: [Amazon ECR Image Tagging](https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-tagging.html)

---

## 4. Database Schema Rollback Strategy (Prisma ORM 6 & Amazon RDS)

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

### Strategy 2: Amazon RDS Point-in-Time Recovery (PITR) (For destructive data loss) `[UNVERIFIED - requires live verification]`
1. In the AWS Management Console, navigate to **Amazon RDS** > **Databases**.
2. Select the staging database instance (`progresseye-staging-db`).
3. Click **Actions** > **Restore to point in time**.
4. Choose **Latest restorable time** or specify a custom timestamp immediately prior to the failed migration.
5. Enter a new DB instance identifier (e.g., `progresseye-staging-db-restored`).
6. Configure the restored instance into the same VPC and private database security group (`progresseye-rds-sg`).
7. Once the restored instance reaches `Available` status, obtain its new endpoint URL.
8. Update `DATABASE_URL` on the EC2 host in `/opt/progresseye/.env` (and SSM Parameter Store `/progresseye/staging/DATABASE_URL`):
   ```bash
   DATABASE_URL="postgresql://<USER>:<PASSWORD>@<NEW_RDS_ENDPOINT>:5432/progresseye_staging?schema=public&sslmode=require"
   ```
9. Restart the API and Worker containers:
   ```bash
   docker compose -f docker-compose.staging.yml restart api worker
   ```
- **Official Docs**: [Restoring an Amazon RDS DB Instance to a Specified Time](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_PIT.html)

---

## 5. Post-Rollback Verification & Smoke Sweep

Immediately after triggering rollback, execute the automated route sweep from local machine or CI runner:
```bash
node scripts/staging-smoke.mjs https://staging.progresseye.com
```
Verify that all routes report `PASS`, security headers are active, and latency is within normal thresholds.

---

## 6. Git Repository State Synchronization

Once staging is verified operational:
1. Identify the regression commit on `main`.
2. Revert the commit cleanly in a dedicated branch:
   ```bash
   git checkout -b revert/incident-fix main
   git revert -m 1 <MERGE_COMMIT_SHA> # If merge commit
   # or
   git revert <COMMIT_SHA> # If standard commit
   git push origin revert/incident-fix
   ```
3. Open PR, verify CI checks pass, and obtain explicit approval before merging.
