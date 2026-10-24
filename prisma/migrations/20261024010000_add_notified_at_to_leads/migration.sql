-- AlterTable
ALTER TABLE "public_leads" ADD COLUMN IF NOT EXISTS "notified_at" TIMESTAMP(3);
