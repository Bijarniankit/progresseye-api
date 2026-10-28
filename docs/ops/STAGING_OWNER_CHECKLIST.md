# ProgressEye Staging Owner Checklist — DigitalOcean BLR1 & AWS SES Mumbai

> **Target Environment**: Staging Pilot  
> **Canonical Domain**: `progresseye.in` (Staging host: `staging.progresseye.in`, API: `staging-api.progresseye.in`)  
> **Target Providers**: DigitalOcean (Region: `blr1` - Bangalore, India) + AWS SES (Region: `ap-south-1` - Mumbai, India)  
> **Status**: Ready for Owner Provisioning. All cost figures and UI flows marked `[UNVERIFIED]` pending live portal verification.

---

## Part 1: DigitalOcean BLR1 (Bangalore) Setup

### Step 1.1: Create Project & Region Context
1. Log in to [DigitalOcean Cloud Console](https://cloud.digitalocean.com/).
2. In the left navigation, click **Projects** > **+ New Project**.
3. Name: `progresseye-staging`, Environment: `Staging`.
4. Region confirmation: Ensure all resources default to datacenter **BLR1 (Bangalore, India)** for Indian data residency.
- **Official Docs**: [DigitalOcean Projects Documentation](https://docs.digitalocean.com/products/projects/)

---

### Step 1.2: Provision Managed PostgreSQL 16
1. Click **Create** > **Databases**.
2. Database Engine: Select **PostgreSQL**, Version **16**.
3. Datacenter: Select **Bangalore (BLR1)**.
4. Cluster Configuration: Select **Basic Nodes** (1 vCPU / 1 GB RAM / 10 GB Disk) for staging pilot.
   - *Cost*: ~$15/month `[UNVERIFIED - requires live verification]`.
5. Cluster Name: `progresseye-staging-db`.
6. Click **Create Database Cluster**.
7. Once provisioned:
   - Go to **Connection details** tab.
   - Note the **Connection Pool** connection string (`DATABASE_URL`) with `pgbouncer=true` and direct connection string.
   - Restrict Trusted Sources to the App Platform app once created.
- **Official Docs**: [DigitalOcean Managed Databases Overview](https://docs.digitalocean.com/products/databases/postgresql/)

---

### Step 1.3: Provision Managed Redis 7
1. Click **Create** > **Databases**.
2. Database Engine: Select **Redis**, Version **7**.
3. Datacenter: Select **Bangalore (BLR1)**.
4. Cluster Configuration: Select **Basic Nodes** (1 vCPU / 1 GB RAM / 10 GB Disk) for staging pilot.
   - *Cost*: ~$15/month `[UNVERIFIED - requires live verification]`.
5. Cluster Name: `progresseye-staging-redis`.
6. Click **Create Database Cluster**.
7. Note the Redis host, port, and password from connection details.
- **Official Docs**: [DigitalOcean Managed Redis Documentation](https://docs.digitalocean.com/products/databases/redis/)

---

### Step 1.4: Create App Platform Services (Web + API)
1. In DigitalOcean Console, click **Create** > **Apps**.
2. Source: Connect GitHub account, select repository `Bijarniankit/progresseye-web` and `Bijarniankit/progresseye-api`.
3. Alternatively, deploy via App Spec using doctl CLI:
   ```bash
   doctl apps create --spec .do/app.yaml
   ```
4. Configure Secrets in App Platform settings (encrypted environment variables):
   - `JWT_ACCESS_SECRET`: Generate via `openssl rand -hex 32`
   - `JWT_REFRESH_SECRET`: Generate via `openssl rand -hex 32`
   - `LEAD_IP_HMAC_SECRET`: Generate via `openssl rand -hex 32`
   - `DATABASE_URL`: Copied from PostgreSQL cluster connection pool
   - `REDIS_PASSWORD`: Copied from Redis cluster
   - `SMTP_USER`: AWS SES SMTP username (from Part 2)
   - `SMTP_PASS`: AWS SES SMTP password (from Part 2)
- *Cost*: Basic XXS instance ($5/month per service) `[UNVERIFIED - requires live verification]`.
- **Official Docs**: [DigitalOcean App Platform Overview](https://docs.digitalocean.com/products/app-platform/)

---

## Part 2: AWS Simple Email Service (SES) Mumbai (`ap-south-1`) Setup

### Step 2.1: Verify Domain Identity
1. Log in to [AWS Management Console](https://console.aws.amazon.com/ses/).
2. Select Region: **Asia Pacific (Mumbai) `ap-south-1`** in the top navigation bar.
3. In left navigation, click **Configuration** > **Identities**.
4. Click **Create identity**.
5. Identity type: Select **Domain**.
6. Domain: Enter `progresseye.in`.
7. Advanced DKIM settings: Select **Easy DKIM**, RSA 2048-bit.
8. Click **Create identity**.
- **Official Docs**: [AWS SES Creating a Domain Identity](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html)

---

### Step 2.2: Add DNS Records at Domain Registrar
AWS SES outputs 3 CNAME records for Easy DKIM. Add them at your DNS registrar:
1. **DKIM Record 1**:
   - Type: `CNAME`
   - Name: `[token1]._domainkey.progresseye.in`
   - Value: `[token1].dkim.amazonses.com`
2. **DKIM Record 2**:
   - Type: `CNAME`
   - Name: `[token2]._domainkey.progresseye.in`
   - Value: `[token2].dkim.amazonses.com`
3. **DKIM Record 3**:
   - Type: `CNAME`
   - Name: `[token3]._domainkey.progresseye.in`
   - Value: `[token3].dkim.amazonses.com`
4. **SPF TXT Record**:
   - Type: `TXT`
   - Name: `@` (or `progresseye.in`)
   - Value: `v=spf1 include:amazonses.com ~all`
5. **DMARC TXT Record**:
   - Type: `TXT`
   - Name: `_dmarc.progresseye.in`
   - Value: `v=DMARC1; p=none; rua=mailto:dmarc-reports@progresseye.in` (Note: `dmarc-reports` mailbox is placeholder until created)
- **Official Docs**: [AWS SES Authenticating Email with DKIM](https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dkim-easy.html)

---

### Step 2.3: Generate SMTP Credentials
1. In AWS SES Console, go to **Account dashboard**.
2. Click **SMTP settings**.
3. Note Server name: `email-smtp.ap-south-1.amazonaws.com`, Port: `587` (STARTTLS).
4. Click **Create SMTP credentials**.
5. IAM User Name: `ses-smtp-progresseye-staging`.
6. Click **Create**.
7. Copy **SMTP User Name** and **SMTP Password**.
8. Paste these into DigitalOcean App Platform environment variables:
   - `SMTP_USER` = `<generated_iam_smtp_user>`
   - `SMTP_PASS` = `<generated_iam_smtp_password>`
- **Official Docs**: [AWS SES Obtaining SMTP Credentials](https://docs.aws.amazon.com/ses/latest/dg/smtp-credentials.html)

---

### Step 2.4: Move Out of SES Sandbox (When Ready for External Leads)
1. In SES Console, go to **Account dashboard**.
2. Click **Request production access**.
3. Mail type: Transactional.
4. Website URL: `https://progresseye.in`.
5. Description: Lead inquiries and administrative transactional notifications for Indian schools.
6. Submit request (approval typically within 24 hours `[UNVERIFIED]`).
- **Official Docs**: [AWS SES Moving out of Sandbox](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)

---

## Part 3: Monthly Cost Summary (Staging Pilot)

| Item | Provider & Tier | Estimated Monthly Cost | Verification Status |
| :--- | :--- | :--- | :--- |
| **Web Service** | DigitalOcean App Platform Basic XXS (1 vCPU, 512MB) | ~$5.00 | `[UNVERIFIED - requires live verification]` |
| **API Service** | DigitalOcean App Platform Basic XXS (1 vCPU, 512MB) | ~$5.00 | `[UNVERIFIED - requires live verification]` |
| **PostgreSQL 16** | DigitalOcean Managed Database (1 vCPU, 1GB RAM) | ~$15.00 | `[UNVERIFIED - requires live verification]` |
| **Redis 7** | DigitalOcean Managed Redis (1 vCPU, 1GB RAM) | ~$15.00 | `[UNVERIFIED - requires live verification]` |
| **Email (SES)** | AWS SES Mumbai ($0.10 / 1,000 emails) | < $1.00 | `[UNVERIFIED - requires live verification]` |
| **Domain .in** | Registry (.in annual renewal ~$10/yr) | ~$0.83 | `[UNVERIFIED - requires live verification]` |
| **Total Pilot** | | **~$41.83 / month** | `[UNVERIFIED - requires live verification]` |
