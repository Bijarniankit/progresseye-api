-- CreateEnum
CREATE TYPE "lead_types" AS ENUM ('CONTACT', 'DEMO', 'NEWSLETTER');

-- CreateEnum
CREATE TYPE "lead_statuses" AS ENUM ('NEW', 'CONTACTED', 'ARCHIVED');

-- CreateTable
CREATE TABLE IF NOT EXISTS "public_leads" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type" "lead_types" NOT NULL,
    "name" TEXT,
    "email" citext NOT NULL,
    "school_name" TEXT,
    "message" TEXT,
    "status" "lead_statuses" NOT NULL DEFAULT 'NEW',
    "consent_text" TEXT NOT NULL,
    "consented_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip_address_hash" TEXT,
    "user_agent" TEXT,
    "idempotency_key" TEXT,
    "retention_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "public_leads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "public_leads_idempotency_key_key" ON "public_leads"("idempotency_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "public_leads_type_created_at_idx" ON "public_leads"("type", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "public_leads_email_idx" ON "public_leads"("email");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "public_leads_status_idx" ON "public_leads"("status");
