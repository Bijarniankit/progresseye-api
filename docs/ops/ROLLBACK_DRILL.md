# ProgressEye Staging Rollback Drill & Operational Procedure

> **Objective**: Validate sub-2-minute zero-downtime rollback capability on DigitalOcean App Platform and Git repository state.

---

## 1. Rollback Trigger Criteria

Initiate a rollback immediately if any of the following occur following a deployment:
- HTTP 5xx error rate exceeds 1% over a 3-minute rolling window.
- Healthcheck endpoint `/api/v1/health/live` returns non-200 or times out.
- The 12-route smoke sweep (`node scripts/staging-smoke.mjs`) reports any route failures.
- Severe performance regression (LCP > 3.5s or CLS > 0.1 on core marketing pages).

---

## 2. DigitalOcean App Platform Instant Rollback (Zero-Downtime)

DigitalOcean App Platform retains previous deployment container images and permits instant 1-click or CLI rollbacks without rebuilding:

### Option A: Via DigitalOcean Cloud Console
1. Navigate to [DigitalOcean App Platform Console](https://cloud.digitalocean.com/apps).
2. Click on the affected app (`progresseye-web` or `progresseye-api`).
3. Click the **Activity** tab to view deployment history.
4. Locate the last known good deployment (marked with green checkmark).
5. Click **Actions** (`...`) next to that deployment and select **Rollback to this deployment**.
6. DigitalOcean immediately re-routes the internal ingress router to the previous running container instances with zero dropped connections.

### Option B: Via `doctl` CLI (< 30 seconds)
```bash
# 1. List recent deployments to find last known good deployment ID
doctl apps list-deployments <APP_ID>

# 2. Trigger instant rollback to the previous deployment ID
doctl apps rollback <APP_ID> --deployment-id <LAST_GOOD_DEPLOYMENT_ID>

# 3. Monitor rollback status
doctl apps get-deployment <APP_ID> <ROLLBACK_DEPLOYMENT_ID>
```
- **Official Docs**: [DigitalOcean App Platform Rollbacks](https://docs.digitalocean.com/products/app-platform/how-to/manage-deployments/#roll-back-a-deployment)

---

## 3. Post-Rollback Verification & Smoke Sweep

Immediately after triggering rollback, execute the automated route sweep:
```bash
node scripts/staging-smoke.mjs https://staging.progresseye.in
```
Verify that all 15 routes report `PASS`, security headers are active, and latency is within normal thresholds (<100ms).

---

## 4. Git Repository State Synchronization

Once the staging traffic is restored to healthy state:
1. Identify the regression commit on `main`.
2. Revert the commit cleanly:
   ```bash
   git checkout -b revert/incident-fix main
   git revert -m 1 <MERGE_COMMIT_SHA> # If merge commit
   # or
   git revert <COMMIT_SHA> # If standard commit
   git push origin revert/incident-fix
   ```
3. Open PR, pass CI, and merge to keep `main` branch synchronized with live staging.
