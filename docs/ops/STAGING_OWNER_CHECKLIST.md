# ProgressEye Staging Owner Checklist — AWS Single-Server & Amazon RDS (ap-south-1 Mumbai)

> **Target Environment**: Staging Pilot  
> **Canonical Domain**: `progresseye.com` (Staging host: `staging.progresseye.com`)  
> **Target Cloud Provider**: Amazon Web Services (AWS)  
> **Target Region**: `ap-south-1` (Asia Pacific - Mumbai, India)  
> **Architecture Topology**: Single EC2 instance running Docker Compose (`caddy` reverse proxy, `web` Next.js 16 standalone, `api` NestJS 11 Fastify, `worker` BullMQ, `redis` Alpine) + managed Amazon RDS PostgreSQL 17 (private). No Application Load Balancer (ALB).  
> **Status**: Ready for Owner Provisioning. All cost figures and unverified console workflows marked `[UNVERIFIED - requires live verification]`.

---

## Table of Contents
1. [AWS ap-south-1 Service Availability Verification](#1-aws-ap-south-1-service-availability-verification)
2. [Single-Server Architecture Risks & Mitigations](#2-single-server-architecture-risks--mitigations)
3. [End-to-End Request Trace & Proxy Hops (`TRUSTED_PROXY_COUNT`)](#3-end-to-end-request-trace--proxy-hops-trusted_proxy_count)
4. [Provider Provisioning Sequence](#4-provider-provisioning-sequence)
5. [Step 1: Domain Registrar & DNS Configuration](#step-1-domain-registrar--dns-configuration)
6. [Step 2: AWS Account Setup (Root MFA, Billing Alarm & IAM)](#step-2-aws-account-setup-root-mfa-billing-alarm--iam)
7. [Step 3: Amazon VPC & Security Groups](#step-3-amazon-vpc--security-groups)
8. [Step 4: Amazon RDS PostgreSQL 17 (Private Database)](#step-4-amazon-rds-postgresql-17-private-database)
9. [Step 5: Amazon EC2 Instance & Elastic IP](#step-5-amazon-ec2-instance--elastic-ip)
10. [Step 6: Host Bootstrap (Docker, Compose & Systems Manager)](#step-6-host-bootstrap-docker-compose--systems-manager)
11. [Step 7: Reverse Proxy (Caddy) & Automatic TLS](#step-7-reverse-proxy-caddy--automatic-tls)
12. [Step 8: Amazon Simple Email Service (SES Mumbai)](#step-8-amazon-simple-email-service-ses-mumbai)
13. [Step 9: Cloudflare Turnstile Anti-Abuse](#step-9-cloudflare-turnstile-anti-abuse)
14. [Step 10: External Uptime Monitoring](#step-10-external-uptime-monitoring)
15. [Secret Distribution & Environment Variable Matrix](#15-secret-distribution--environment-variable-matrix)
16. [Monthly Cost Table & Official AWS Pricing Links](#16-monthly-cost-table--official-aws-pricing-links)

---

## 1. AWS ap-south-1 Service Availability Verification

All required services for this staging topology are confirmed available in the **Asia Pacific (Mumbai)** region (`ap-south-1`):

- **AWS Regional Services Table**:  
  Official URL: [AWS Regional Services Database](https://aws.amazon.com/about-aws/global-infrastructure/regional-product-services/)
- **Amazon EC2 (ap-south-1)**:  
  Official URL: [Amazon EC2 Endpoints and Quotas](https://docs.aws.amazon.com/general/latest/gr/ec2-service.html) (Endpoint: `ec2.ap-south-1.amazonaws.com`)
- **Amazon RDS for PostgreSQL 17 (ap-south-1)**:  
  Official URL: [Amazon RDS Supported PostgreSQL Versions](https://docs.aws.amazon.com/AmazonRDS/latest/PostgreSQLReleaseNotes/postgresql-versions.html#postgresql-versions-17)  
  Official URL: [Amazon RDS Endpoints](https://docs.aws.amazon.com/general/latest/gr/rdb.html) (Endpoint: `rds.ap-south-1.amazonaws.com`)
- **Amazon Simple Email Service (SES Mumbai)**:  
  Official URL: [Amazon SES Endpoints and Quotas](https://docs.aws.amazon.com/general/latest/gr/ses.html) (Endpoint: `email.ap-south-1.amazonaws.com`, SMTP: `email-smtp.ap-south-1.amazonaws.com`)

---

## 2. Single-Server Architecture Risks & Mitigations

Deploying Web, API, Worker, Redis, and Reverse Proxy on a single EC2 instance minimizes infrastructure cost for staging, but introduces specific operational trade-offs:

| Risk | Description & Impact | Required Minimum Operational Mitigation |
|---|---|---|
| **No High Availability (Single Host SPOF)** | If the EC2 virtual machine fails, encounters underlying hardware faults, or AWS availability zone disruption occurs, all application components go offline simultaneously. | 1. **External Database**: Postgres 17 runs on managed Amazon RDS, isolated from EC2 host failure.<br>2. **Automated EBS Snapshots**: AWS Data Lifecycle Manager (DLM) configured to take daily root volume snapshots.<br>3. **External Health Monitoring**: 60-second polling via Better Stack/UptimeRobot with instant SMS/push alerts. |
| **OS Patching & Kernel Reboots** | Host operating system updates (`dnf update` / `apt upgrade`) require occasional reboots, taking the ingress offline. | 1. **Off-Hours Maintenance Windows**: Apply updates only during pre-announced maintenance hours.<br>2. **Nitro Hypervisor Fast Reboot**: AWS `t3`/`t4g` instances reboot within ~30–45 seconds.<br>3. **Docker Daemon Autostart**: Enable `systemctl enable docker` and set container restart policies to `unless-stopped`. |
| **Container Redeployment Downtime** | Running `docker compose up -d` recreates application containers, causing brief TCP connection resets (no rolling zero-downtime ALB). | 1. **Zero-downtime is explicitly UNVERIFIED / NOT claimed**.<br>2. **Caddy Reverse Proxy Buffer**: Caddy holds incoming connections momentarily while upstream web:3000 rebinds.<br>3. **Sequential Staging Restarts**: Rebuild images out-of-band before triggering `docker compose up -d`. |
| **Resource Contention & OOM Kills** | Next.js SSR build spikes or BullMQ PDF/email jobs could consume RAM, triggering the Linux Out-Of-Memory (OOM) killer on Redis or the API. | 1. **Swap Allocation**: Configure 2–4 GB swapfile on the host EBS volume.<br>2. **Redis Memory Limit**: Configure Redis with `--maxmemory 256mb --maxmemory-policy noeviction`.<br>3. **Staging Cache Alternative**: ElastiCache for Redis is designated as the subsequent production upgrade path. |

---

## 3. End-to-End Request Trace & Proxy Hops (`TRUSTED_PROXY_COUNT`)

### Concrete Request Walkthrough: Contact Form Submission
Consider a prospective school principal submitting the contact form on `https://staging.progresseye.com/contact`:

```
[Browser Client]
  IP: 203.0.113.195
        │
        ▼ (HTTPS POST https://staging.progresseye.com/api/v1/public/contact)
[Reverse Proxy: Caddy Container] (port 443 -> host network)
  Terminates TLS via Let's Encrypt / ZeroSSL.
  Appends headers:
    X-Forwarded-For: 203.0.113.195
    X-Forwarded-Proto: https
    X-Forwarded-Host: staging.progresseye.com
        │
        ▼ (HTTP cleartext on Docker bridge network: progresseye-net)
[Web Container: Next.js 16 Standalone Server] (web:3000)
  Evaluates next.config.ts rewrites:
    source: "/api/:path*" -> destination: "http://api:4000/api/:path*"
  Proxies request to API_INTERNAL_URL.
  Next.js proxy forwarder handles headers:
    Appends upstream connecting IP or forwards X-Forwarded-For.
        │
        ▼ (HTTP cleartext on Docker bridge network: progresseye-net)
[API Container: NestJS 11 / Fastify] (api:4000)
  Fastify trustProxy algorithm evaluates request:
    Connecting Socket IP: IP of web container (e.g. 172.20.0.3)
    Incoming X-Forwarded-For: "203.0.113.195, 172.20.0.2" (or "203.0.113.195")
```

### Why `TRUSTED_PROXY_COUNT` Must Be Confirmed via Staging Hop-Trace
- **If Next.js rewrite appends the proxy's IP**: The header arriving at the API contains two hops (`203.0.113.195, 172.20.0.2`). Fastify requires `TRUSTED_PROXY_COUNT=2` to walk backward past both the `web` container and the `caddy` container to extract the real client IP `203.0.113.195`.
- **If Next.js rewrite transparently forwards `X-Forwarded-For` without appending**: The header arriving at the API contains one hop (`203.0.113.195`). Fastify requires `TRUSTED_PROXY_COUNT=1`.
- **Operational Directive**: **DO NOT ASSUME**. After starting staging, curl the diagnostic endpoint:
  ```bash
  curl -H "X-Forwarded-For: 203.0.113.195" https://staging.progresseye.com/api/v1/health/hop-trace
  ```
  Inspect the returned `clientIp`, `ips`, and `rawHeaders`. Adjust `TRUSTED_PROXY_COUNT` in `.env` / SSM Parameter Store so that `clientIp` matches the true origin IP before enabling strict rate limiting.

---

## 4. Provider Provisioning Sequence
Provision infrastructure strictly in this order to resolve network and credential dependencies:
1. **Registrar / DNS**: Register domain and configure initial A / CNAME records.
2. **AWS Account**: Configure Root MFA, CloudWatch billing alarm, and deploy an admin IAM user.
3. **AWS Networking**: Create VPC, public subnet (EC2), and private subnets (RDS).
4. **Amazon RDS**: Provision PostgreSQL 17 inside the private database security group.
5. **Amazon EC2**: Launch instance with Elastic IP and attach SSM IAM Instance Profile.
6. **Docker Bootstrap**: Install Docker Engine & Compose; configure non-root runner user.
7. **Reverse Proxy (Caddy)**: Deploy Caddy to terminate HTTPS and bind ports 80/443.
8. **Amazon SES**: Verify `progresseye.com`, configure DKIM/SPF DNS records, and obtain SMTP credentials.
9. **Cloudflare Turnstile**: Register hostnames `progresseye.com` and `staging.progresseye.com`.
10. **Uptime Monitor**: Configure 60s HTTP polling on `/api/v1/health/live` and `/`.

---

## Step 1: Domain Registrar & DNS Configuration
1. Register `progresseye.com` at an ICANN-accredited registrar (e.g. Amazon Route 53, Namecheap, Cloudflare Registrar).
2. Configure DNS A Record `[UNVERIFIED - requires live verification]`:
   - Name: `staging.progresseye.com`
   - Type: `A`
   - Value: `<ALLOCATED_EC2_ELASTIC_IP>`
   - TTL: `300` seconds (5 minutes for staging agility)
3. Reserve root apex record for production:
   - Name: `progresseye.com` -> Reserved for subsequent production launch.
- **Official Docs**: [Amazon Route 53 Routing Traffic to EC2](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/routing-to-ec2-instance.html)

---

## Step 2: AWS Account Setup (Root MFA, Billing Alarm & IAM)
1. **Enable Root Account MFA**: In the AWS Console, click account name > **Security credentials** > **Assign MFA**. Configure a FIDO2 hardware security key or authenticator app.
   - Official Docs: [AWS IAM Root User MFA](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_mfa_enable_virtual.html)
2. **Create Monthly Billing Alarm**:
   - Navigate to **CloudWatch** > **Alarms** > **Create alarm**.
   - Metric: `AWS/Billing` > `EstimatedCharges` (Currency: USD).
   - Condition: Static, Greater than `$75` (safeguard against unexpected data transfer or instance spikes).
   - Action: Trigger SNS notification to owner email (`admin@progresseye.com`).
   - Official Docs: [Creating a Billing Alarm in CloudWatch](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/monitor_estimated_charges_with_cloudwatch.html)
3. **Create Deployment IAM User / Role**:
   - Do NOT use the root account for daily operations.
   - Navigate to **IAM** > **Users** > **Create user**: `progresseye-admin`.
   - Grant `AdministratorAccess` with enforced MFA.
   - Official Docs: [AWS IAM Best Practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html)

---

## Step 3: Amazon VPC & Security Groups
Configure minimal network isolation in `ap-south-1`:
1. Use default VPC or create a dedicated VPC (`10.0.0.0/16`) in `ap-south-1`.
2. **EC2 Security Group (`progresseye-ec2-sg`)**:
   - Inbound Rules:
     - `HTTP` (TCP 80): Source `0.0.0.0/0` (Redirected to HTTPS by Caddy)
     - `HTTPS` (TCP 443): Source `0.0.0.0/0` (Public web traffic)
     - `SSH` (TCP 22): **None** (Access via AWS Systems Manager Session Manager eliminates port 22 exposure). If SSH is preferred, restrict strictly to owner's static IP (`<OWNER_IP>/32`).
   - Outbound Rules: `All traffic` (`0.0.0.0/0`)
3. **RDS Security Group (`progresseye-rds-sg`)**:
   - Inbound Rules:
     - `PostgreSQL` (TCP 5432): Source strictly set to Security Group ID of `progresseye-ec2-sg` (No public internet access).
   - Outbound Rules: `None` or default.
- **Official Docs**: [Amazon EC2 Security Groups](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-security-groups.html)

---

## Step 4: Amazon RDS PostgreSQL 17 (Private Database)
1. Navigate to **Amazon RDS** > **Databases** > **Create database**.
2. Method: **Standard create**.
3. Engine: **PostgreSQL**, Engine Version: **PostgreSQL 17.2-R1** (or latest minor 17.x in `ap-south-1`).
4. Templates: **Dev/Test** (or Free Tier if eligible).
5. Settings:
   - DB instance identifier: `progresseye-staging-db`
   - Master username: `progresseye_admin`
   - Master password: Auto-generate or set strong 32-character random string (store immediately in AWS SSM Parameter Store).
6. Instance Configuration:
   - DB instance class: **Burstable classes (includes t classes)** > `db.t4g.micro` (2 vCPU, 1 GB RAM, ~$0.018/hr) or `db.t3.micro`.
7. Storage:
   - Storage type: **General Purpose SSD (gp3)**
   - Allocated storage: `20` GiB
   - Storage autoscaling: Disable for staging budget predictability.
8. Connectivity:
   - Virtual Private Cloud (VPC): Select staging VPC.
   - Public access: **No** (Strictly private).
   - Existing VPC security groups: Select `progresseye-rds-sg`.
   - Availability Zone: No preference (Single-AZ for staging cost savings).
   - Database port: `5432`.
9. Database Authentication: Password authentication.
10. Additional Configuration:
    - Initial database name: `progresseye_staging`
    - Backup retention period: `7` days (automated point-in-time recovery enabled).
    - Backup window: `20:00 - 20:30 UTC` (`01:30 - 02:00 IST`).
    - Deletion protection: **Enable**.
11. Click **Create database**.
12. Once status is `Available`, copy the **Endpoint** (e.g. `progresseye-staging-db.cxxxx.ap-south-1.rds.amazonaws.com`).
- **Official Docs**: [Creating an Amazon RDS DB Instance](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_CreateDBInstance.html)

---

## Step 5: Amazon EC2 Instance & Elastic IP
1. **Create IAM Instance Profile for EC2**:
   - Navigate to **IAM** > **Roles** > **Create role**.
   - Trusted entity: **AWS service** > **EC2**.
   - Permissions: Attach `AmazonSSMManagedInstanceCore` (enables browser SSH via SSM Session Manager without open ports) and an inline policy granting `ssm:GetParametersByPath` on `/progresseye/staging/*`.
   - Role name: `ProgressEyeEC2Role`.
2. **Launch EC2 Instance**:
   - Navigate to **Amazon EC2** > **Instances** > **Launch an instance**.
   - Name: `progresseye-staging-server`.
   - AMI: **Amazon Linux 2023 AMI** or **Ubuntu 24.04 LTS** (64-bit x86).
   - Instance type: `t3.medium` (2 vCPU, 4 GiB RAM, ~$0.0416/hr) to support Docker Compose, Caddy, Next.js standalone, NestJS, BullMQ worker, and Redis without memory starvation.
   - Key pair: Select or create key pair (or proceed without if using SSM Session Manager).
   - Network settings:
     - VPC: Staging VPC.
     - Auto-assign public IP: Enable.
     - Security group: Select `progresseye-ec2-sg`.
   - Storage: `30` GiB gp3 root volume.
   - Advanced details > IAM instance profile: Select `ProgressEyeEC2Role`.
   - Click **Launch instance**.
3. **Allocate & Associate Elastic IP**:
   - Navigate to **EC2** > **Elastic IPs** > **Allocate Elastic IP address** (Region: `ap-south-1`).
   - Select the allocated IP > **Actions** > **Associate Elastic IP address**.
   - Resource type: **Instance** > Select `progresseye-staging-server`.
   - Copy the public IPv4 address and update DNS A record (`staging.progresseye.com`).
- **Official Docs**: [Amazon EC2 Launching an Instance](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/launching-instance.html)
- **Official Docs**: [Amazon Elastic IP Addresses](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/elastic-ip-addresses-eip.html)

---

## Step 6: Host Bootstrap (Docker, Compose & Systems Manager)
1. Connect to the instance using SSM Session Manager:
   ```bash
   aws ssm start-session --target <INSTANCE_ID> --region ap-south-1
   ```
2. Install Docker and Docker Compose plugin:
   ```bash
   # Amazon Linux 2023
   sudo dnf update -y
   sudo dnf install -y docker git
   sudo systemctl enable --now docker
   sudo usermod -aG docker ssm-user
   
   # Install Docker Compose v2 plugin
   sudo mkdir -p /usr/local/lib/docker/cli-plugins
   sudo curl -SL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64 \
     -o /usr/local/lib/docker/cli-plugins/docker-compose
   sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
   ```
3. Configure 2 GB Swap File (prevents out-of-memory container terminations):
   ```bash
   sudo dd if=/dev/zero of=/swapfile bs=128M count=16
   sudo chmod 600 /swapfile
   sudo mkswap /swapfile
   sudo swapon /swapfile
   echo '/swapfile swap swap defaults 0 0' | sudo tee -a /etc/fstab
   ```
4. Clone the application repositories to `/opt/progresseye`:
   ```bash
   sudo mkdir -p /opt/progresseye
   sudo chown -R $USER:$USER /opt/progresseye
   cd /opt/progresseye
   git clone https://github.com/Bijarniankit/progresseye-web.git web
   git clone https://github.com/Bijarniankit/progresseye-api.git api
   ```
- **Official Docs**: [Docker Engine on Amazon Linux](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/docker-basics.html)

---

## Step 7: Reverse Proxy (Caddy) & Automatic TLS
1. Place the verified `Caddyfile` in `/opt/progresseye/web/Caddyfile`:
   ```caddy
   {
       email admin@progresseye.com
   }

   staging.progresseye.com {
       encode gzip zstd

       header {
           Strict-Transport-Security "max-age=31536000; includeSubDomains"
           X-Content-Type-Options "nosniff"
           X-Frame-Options "DENY"
           Referrer-Policy "strict-origin-when-cross-origin"
           -Server
       }

       reverse_proxy web:3000 {
           header_up Host {host}
           header_up X-Real-IP {remote_host}
           header_up X-Forwarded-For {remote_host}
           header_up X-Forwarded-Proto {scheme}
           header_up X-Forwarded-Host {host}
       }
   }
   ```
2. Caddy automatically provisions and renews TLS certificates via Let's Encrypt / ZeroSSL on port 80/443 without external cron jobs.
- **Official Docs**: [Caddy Reverse Proxy Documentation](https://caddyserver.com/docs/quick-starts/reverse-proxy)

---

## Step 8: Amazon Simple Email Service (SES Mumbai)
1. **Verify Domain Identity**:
   - In the AWS Management Console, navigate to **Amazon SES** (Region: **Mumbai / ap-south-1**).
   - In left menu, click **Configuration** > **Identities** > **Create identity**.
   - Identity type: **Domain**, Domain: `progresseye.com`.
   - Advanced DKIM settings: **Easy DKIM**, DKIM signing key length: **RSA_2048_BIT**.
   - Click **Create identity**.
2. **Add DKIM & SPF DNS Records**:
   - Copy the 3 generated CNAME records (e.g. `xxxx._domainkey.progresseye.com`) into your DNS registrar zone.
   - Add SPF TXT record on apex `progresseye.com`:  
     `v=spf1 include:amazonses.com ~all`
   - Add DMARC TXT record on `_dmarc.progresseye.com`:  
     `v=DMARC1; p=none; rua=mailto:dmarc-reports@progresseye.com`
   - Wait for SES status to transition to **Verified**.
3. **Generate SMTP Credentials**:
   - Navigate to **SES** > **Account dashboard** > **SMTP settings**.
   - Click **Create SMTP credentials**.
   - IAM User name: `progresseye-ses-smtp-user`.
   - Copy **SMTP Username** and **SMTP Password** (store immediately in SSM Parameter Store).
   - Host: `email-smtp.ap-south-1.amazonaws.com`, Port: `587` (STARTTLS) or `465` (TLS).
4. **Request Production Sandbox Exit `[UNVERIFIED - requires live verification]`**:
   - Click **Request production access** on the SES Account dashboard.
   - Mail type: Transactional (institutional inquiry auto-responder and internal lead alerts).
   - Website URL: `https://progresseye.com`.
   - Submit for AWS review (~24–48 hours approval time).
- **Official Docs**: [Amazon SES Verifying a Domain](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html#verify-domain-procedure)

---

## Step 9: Cloudflare Turnstile Anti-Abuse
1. Log in to the [Cloudflare Dashboard](https://dash.cloudflare.com/) > **Turnstile**.
2. Click **Add site**.
3. Site name: `ProgressEye Staging`.
4. Domain: `progresseye.com` and `staging.progresseye.com`.
5. Widget Mode: **Managed**.
6. Copy:
   - **Site Key** -> Add to `NEXT_PUBLIC_TURNSTILE_SITE_KEY`.
   - **Secret Key** -> Store in SSM Parameter Store (`/progresseye/staging/TURNSTILE_SECRET_KEY`).
- **Official Docs**: [Cloudflare Turnstile Getting Started](https://developers.cloudflare.com/turnstile/get-started/)

---

## Step 10: External Uptime Monitoring
1. Create a monitor on [Better Stack](https://betterstack.com/) or [UptimeRobot](https://uptimerobot.com/).
2. **Monitor A (Web Ingress)**:
   - URL: `https://staging.progresseye.com/`
   - Interval: `60` seconds, Alert on HTTP != 200.
3. **Monitor B (API Health)**:
   - URL: `https://staging.progresseye.com/api/v1/health/live`
   - Interval: `60` seconds, Alert on HTTP != 200.
- **Official Docs**: [Better Stack Uptime Monitoring](https://betterstack.com/docs/uptime/)

---

## 15. Secret Distribution & Environment Variable Matrix

All secrets MUST be stored in **AWS Systems Manager (SSM) Parameter Store** (SecureString, encrypted with KMS key `alias/aws/ssm`), never in Git:

| Parameter Name (SSM) | Target Service | Parameter Type | Description / Destination |
|---|---|---|---|
| `/progresseye/staging/DATABASE_URL` | API, Worker | `SecureString` | PostgreSQL connection string with SSL required (`postgresql://user:pass@host:5432/progresseye_staging?schema=public&sslmode=require`) |
| `/progresseye/staging/DIRECT_URL` | API | `SecureString` | Direct non-pooled Postgres URL for Prisma schema migrations |
| `/progresseye/staging/TURNSTILE_SECRET_KEY` | API | `SecureString` | Cloudflare Turnstile private secret key for server-side validation |
| `/progresseye/staging/SES_SMTP_USER` | API, Worker | `SecureString` | AWS SES IAM SMTP Username |
| `/progresseye/staging/SES_SMTP_PASSWORD` | API, Worker | `SecureString` | AWS SES IAM SMTP Password |

### Service Environment Variable Matrix
```bash
# Web Service (progresseye-web)
NODE_ENV=production
PORT=3000
HOSTNAME=0.0.0.0
NEXT_PUBLIC_SITE_URL=https://staging.progresseye.com
NEXT_PUBLIC_APP_ENV=production
NEXT_PUBLIC_HAS_LEAD_BACKEND=true
NEXT_PUBLIC_TURNSTILE_SITE_KEY=<CLOUDFLARE_SITE_KEY>
NEXT_PUBLIC_SUPPORT_EMAIL=support@progresseye.com
API_INTERNAL_URL=http://api:4000

# API Service (progresseye-api)
NODE_ENV=production
PORT=4000
HOSTNAME=0.0.0.0
DATABASE_URL=<FETCHED_FROM_SSM>
DIRECT_URL=<FETCHED_FROM_SSM>
REDIS_URL=redis://redis:6379
TRUSTED_PROXY_COUNT=2  # Confirm via /api/v1/health/hop-trace
CORS_ORIGIN=https://staging.progresseye.com,https://progresseye.com
TURNSTILE_SECRET_KEY=<FETCHED_FROM_SSM>
SES_REGION=ap-south-1
AWS_REGION=ap-south-1
MAIL_FROM=noreply@progresseye.com
LEAD_NOTIFICATION_RECIPIENT=leads@progresseye.com

# Worker Service (progresseye-worker)
NODE_ENV=production
DATABASE_URL=<FETCHED_FROM_SSM>
DIRECT_URL=<FETCHED_FROM_SSM>
REDIS_URL=redis://redis:6379
SES_REGION=ap-south-1
AWS_REGION=ap-south-1
MAIL_FROM=noreply@progresseye.com
LEAD_NOTIFICATION_RECIPIENT=leads@progresseye.com
```

---

## 16. Monthly Cost Table & Official AWS Pricing Links

All pricing calculated for **AWS Region `ap-south-1` (Mumbai)** based on standard 730 hours/month:

| Infrastructure Item | Specifications | Monthly Cost (USD) | Official AWS Pricing Documentation |
|---|---|---|---|
| **Amazon EC2 Instance** | `t3.medium` (2 vCPU, 4 GiB RAM, Linux) | ~$30.37 ($0.0416/hr) | [Amazon EC2 On-Demand Pricing](https://aws.amazon.com/ec2/pricing/on-demand/) |
| **EC2 EBS Root Volume** | 30 GiB General Purpose SSD (gp3) | ~$2.40 ($0.08/GB-mo) | [Amazon EBS Pricing](https://aws.amazon.com/ebs/pricing/) |
| **Public IPv4 Address** | 1 In-use Elastic IP (730 hrs) | ~$3.65 ($0.005/hr) | [Amazon EC2 IPv4 Pricing](https://aws.amazon.com/ec2/pricing/on-demand/#Public_IPv4_Address_Pricing) |
| **Amazon RDS Instance** | `db.t4g.micro` (2 vCPU, 1 GiB RAM, Single-AZ) | ~$13.14 ($0.018/hr) | [Amazon RDS PostgreSQL Pricing](https://aws.amazon.com/rds/postgresql/pricing/) |
| **Amazon RDS Storage** | 20 GiB General Purpose SSD (gp3) | ~$2.30 ($0.115/GB-mo) | [Amazon RDS Storage Pricing](https://aws.amazon.com/rds/postgresql/pricing/) |
| **RDS Automated Backups** | 7-day retention (up to 100% of DB storage) | $0.00 (Free Tier) | [Amazon RDS Backup Pricing](https://aws.amazon.com/rds/postgresql/pricing/) |
| **Amazon SES Emails** | First 62,000 emails/mo from EC2 | $0.00 (Free Tier) | [Amazon SES Pricing](https://aws.amazon.com/ses/pricing/) |
| **AWS Systems Manager** | Standard Parameter Store (< 10,000 params) | $0.00 (Always Free) | [AWS Systems Manager Pricing](https://aws.amazon.com/systems-manager/pricing/) |
| **CloudWatch Billing Alarm** | 1 Metric Alarm (Free tier includes 10 alarms) | $0.00 (Free Tier) | [Amazon CloudWatch Pricing](https://aws.amazon.com/cloudwatch/pricing/) |
| **Data Transfer Out** | First 100 GiB/month to internet | $0.00 (AWS Free Tier) | [AWS EC2 Data Transfer Pricing](https://aws.amazon.com/ec2/pricing/on-demand/#Data_Transfer) |
| **Total Estimated Staging Cost** | **Comprehensive Single-Server + RDS Stack** | **~$51.86 / month** `[UNVERIFIED - requires live verification]` | |
