# ProgressEye Staging Owner Checklist — DigitalOcean BLR1 & AWS SES Mumbai

> **Target Environment**: Staging Pilot  
> **Canonical Domain**: `progresseye.in` (Staging host: `staging.progresseye.in`)  
> **Target Providers**: DigitalOcean (Region: `blr1` - Bangalore, India) + AWS SES (Region: `ap-south-1` - Mumbai, India)  
> **Status**: Ready for Owner Provisioning. All cost figures and unverified console flows marked `[UNVERIFIED - requires live verification]`.

---

## Table of Contents
1. [Provider Provisioning Sequence](#provider-provisioning-sequence)
2. [Part 1: Domain Registrar & DNS Configuration](#part-1-domain-registrar--dns-configuration)
3. [Part 2: DigitalOcean BLR1 (Bangalore) Infrastructure](#part-2-digitalocean-blr1-bangalore-infrastructure)
   - [Step 2.1: Project Setup](#step-21-project-setup)
   - [Step 2.2: Managed PostgreSQL 17](#step-22-managed-postgresql-17)
   - [Step 2.3: Managed Valkey / Redis](#step-23-managed-valkey--redis)
   - [Step 2.4: App Platform (Web & API)](#step-24-app-platform-web--api)
4. [Part 3: AWS SES Mumbai (ap-south-1) Configuration](#part-3-aws-ses-mumbai-ap-south-1-configuration)
   - [Step 3.1: Domain Identity & DKIM](#step-31-domain-identity--dkim)
   - [Step 3.2: SMTP Credentials](#step-32-smtp-credentials)
   - [Step 3.3: Production Sandbox Exit](#step-33-production-sandbox-exit)
5. [Part 4: Cloudflare Turnstile Anti-Abuse](#part-4-cloudflare-turnstile-anti-abuse)
6. [Part 5: External Uptime Monitoring](#part-5-external-uptime-monitoring)
7. [Part 6: Secret Distribution Matrix](#part-6-secret-distribution-matrix)
8. [Part 7: Monthly Cost Summary & Official Documentation URLs](#part-7-monthly-cost-summary--official-documentation-urls)

---

## Provider Provisioning Sequence
Provision providers strictly in this order to satisfy DNS and secret dependencies:
1. **Registrar / DNS**: Register domain and configure nameservers.
2. **DigitalOcean**: Provision Managed DBs (PostgreSQL 17, Valkey/Redis) and App Platform services.
3. **AWS SES (ap-south-1)**: Verify domain, add DKIM/SPF DNS records, and generate SMTP credentials.
4. **Cloudflare Turnstile**: Add site hostname `progresseye.in` / `staging.progresseye.in`, obtain Site Key & Secret Key.
5. **Uptime Monitor**: Configure HTTPS liveness monitoring on `/api/v1/health/live` and `/`.

---

## Part 1: Domain Registrar & DNS Configuration
1. Register `progresseye.in` at chosen registrar (e.g., INRegistry accredited registrars).
2. Point DNS NS records to DigitalOcean Nameservers (`ns1.digitalocean.com`, `ns2.digitalocean.com`, `ns3.digitalocean.com`) or manage DNS directly.
- **Official Docs**: [DigitalOcean DNS Management](https://docs.digitalocean.com/products/networking/dns/)

---

## Part 2: DigitalOcean BLR1 (Bangalore) Infrastructure

### Step 2.1: Project Setup
1. Log in to [DigitalOcean Cloud Console](https://cloud.digitalocean.com/).
2. In the left navigation, click **Projects** > **+ New Project**.
3. Name: `progresseye-staging`, Environment: `Staging`.
4. Datacenter: Default to **BLR1 (Bangalore, India)** for Indian data residency.
- **Official Docs**: [DigitalOcean Projects](https://docs.digitalocean.com/products/projects/)

### Step 2.2: Managed PostgreSQL 17
1. Click **Create** > **Databases**.
2. Engine: **PostgreSQL**, Version: **17**.
3. Datacenter: **Bangalore (BLR1)**.
4. Tier: **Basic Nodes** (1 vCPU / 1 GB RAM / 10 GB Disk) `[UNVERIFIED - requires live verification]`.
5. Cluster Name: `progresseye-staging-pg`.
6. Once provisioned, note:
   - `DATABASE_URL` (Connection pool mode, PgBouncer port 25060, `sslmode=require`).
   - `DIRECT_URL` (Direct node connection port 25061 for Prisma migrations).
- **Official Docs**: [DigitalOcean Managed PostgreSQL](https://docs.digitalocean.com/products/databases/postgresql/)

### Step 2.3: Managed Valkey / Redis `[UNVERIFIED - requires live verification]`
> [!NOTE]
> DigitalOcean has transitioned new caching clusters to Valkey (open source Redis fork) while preserving Redis API compatibility.
1. Click **Create** > **Databases**.
2. Select **Valkey** (or **Redis** if available), Version **7 / 8**.
3. Datacenter: **Bangalore (BLR1)**.
4. Tier: **Basic Nodes** (1 vCPU / 1 GB RAM) `[UNVERIFIED - requires live verification]`.
5. Name: `progresseye-staging-redis`.
6. Record: `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_TLS=true`.
- **Official Docs**: [DigitalOcean Valkey/Redis](https://docs.digitalocean.com/products/databases/valkey/)

### Step 2.4: App Platform (Web & API)
1. Deploy from GitHub repository `Bijarniankit/progresseye-api` and `Bijarniankit/progresseye-web` using `.do/app.yaml`.
2. Region: `blr1`.
3. Configure Healthcheck endpoints:
   - API: `/api/v1/health/live` (HTTP 200)
   - Web: `/` (HTTP 200)
- **Official Docs**: [DigitalOcean App Platform](https://docs.digitalocean.com/products/app-platform/)

---

## Part 3: AWS SES Mumbai (ap-south-1) Configuration

### Step 3.1: Domain Identity & DKIM
1. Log in to AWS Console > Region **ap-south-1 (Mumbai)**.
2. Navigate to **Amazon Simple Email Service (SES)** > **Identities**.
3. Click **Create Identity** > Domain: `progresseye.in`.
4. Select **Easy DKIM** (RSA 2048-bit).
5. Add the 3 generated CNAME records and MX/SPF records (`v=spf1 include:amazonses.com ~all`) to your DNS registrar.
- **Official Docs**: [AWS SES Easy DKIM](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html)

### Step 3.2: SMTP Credentials
1. Under SES > **SMTP Settings**, click **Create SMTP credentials**.
2. Note `SMTP_HOST`: `email-smtp.ap-south-1.amazonaws.com`, `SMTP_PORT`: `587`.
3. Save generated IAM SMTP Username and Password.
- **Official Docs**: [AWS SES SMTP Credentials](https://docs.aws.amazon.com/ses/latest/dg/smtp-credentials.html)

### Step 3.3: Production Sandbox Exit `[UNVERIFIED - requires live verification]`
1. Under SES > **Account dashboard**, click **Request production access**.
2. Mail type: Transactional (institutional inquiry receipts & notifications).
3. Compliance notes: Single opt-in lead forms with explicit consent checkbox, zero unsolicited cold outbound.
- **Official Docs**: [AWS SES Sandbox Exit](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)

---

## Part 4: Cloudflare Turnstile Anti-Abuse
1. Log in to Cloudflare Dashboard > **Turnstile**.
2. Click **Add Site**.
3. Name: `ProgressEye Staging`, Domain: `progresseye.in` and `staging.progresseye.in`.
4. Widget Mode: **Managed** (Interactive challenge only upon suspicion).
5. Copy `Site Key` -> `NEXT_PUBLIC_TURNSTILE_SITE_KEY`.
6. Copy `Secret Key` -> `TURNSTILE_SECRET_KEY`.
- **Official Docs**: [Cloudflare Turnstile Getting Started](https://developers.cloudflare.com/turnstile/get-started/)

---

## Part 5: External Uptime Monitoring
1. Set up an external uptime monitor (e.g., Better Stack / UptimeRobot).
2. Monitor checks:
   - Web: `https://staging.progresseye.in/` (expect HTTP 200, interval 1m)
   - API: `https://staging.progresseye.in/api/v1/health/live` (expect HTTP 200, interval 1m)
- **Official Docs**: [Better Stack Uptime](https://betterstack.com/docs/uptime/)

---

## Part 6: Secret Distribution Matrix

| Secret / Environment Variable | Destination Component | Secret Location / Vault |
| :--- | :--- | :--- |
| `DATABASE_URL` (PgBouncer, TLS) | `progresseye-api` | DigitalOcean App Platform Encrypted Env |
| `DIRECT_URL` (Direct node, TLS) | `progresseye-api` | DigitalOcean App Platform Encrypted Env |
| `REDIS_PASSWORD` | `progresseye-api` | DigitalOcean App Platform Encrypted Env |
| `TURNSTILE_SECRET_KEY` | `progresseye-api` | DigitalOcean App Platform Encrypted Env |
| `SMTP_USER` & `SMTP_PASS` | `progresseye-api` | DigitalOcean App Platform Encrypted Env |
| `APP_SECRET` / `CORS_ORIGIN` | `progresseye-api` | DigitalOcean App Platform Encrypted Env |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | `progresseye-web` | App Platform Build & Run Env |
| `API_INTERNAL_URL` | `progresseye-web` | App Platform Run-time Env (Internal Service) |

---

## Part 7: Monthly Cost Summary & Official Documentation URLs

### Cost Estimate (Staging Pilot)
Source: [DigitalOcean Pricing](https://www.digitalocean.com/pricing), [AWS SES Pricing](https://aws.amazon.com/ses/pricing/)

| Component | Provider & Plan / Specification | Estimated Monthly Cost | Source / Verification URL |
| :--- | :--- | :--- | :--- |
| **Web Service** | DigitalOcean App Platform Basic (1 vCPU, 512MB RAM) | ~$5.00 | [DO App Platform Pricing](https://www.digitalocean.com/pricing/app-platform) `[UNVERIFIED]` |
| **API Service** | DigitalOcean App Platform Basic (1 vCPU, 512MB RAM) | ~$5.00 | [DO App Platform Pricing](https://www.digitalocean.com/pricing/app-platform) `[UNVERIFIED]` |
| **PostgreSQL 17** | DigitalOcean Managed PostgreSQL (1 vCPU, 1GB RAM) | ~$15.00 | [DO Managed DB Pricing](https://www.digitalocean.com/pricing/databases) `[UNVERIFIED]` |
| **Valkey / Redis** | DigitalOcean Managed Valkey/Redis (1 vCPU, 1GB RAM) | ~$15.00 | [DO Managed DB Pricing](https://www.digitalocean.com/pricing/databases) `[UNVERIFIED]` |
| **Transactional Email** | AWS SES Mumbai (1,000 emails/mo) | < $0.20 | [AWS SES Pricing](https://aws.amazon.com/ses/pricing/) `[UNVERIFIED]` |
| **Domain Registration** | .in Registry annual amortized | ~$0.83 ($10/yr) | [Registry Pricing](https://registry.in) `[UNVERIFIED]` |
| **Total Staging Pilot** | | **~$41.03 / month** | `[UNVERIFIED - requires live verification]` |
