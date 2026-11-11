import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
import * as argon2 from "argon2";

const SYSTEM_TENANT_ID = "00000000-0000-0000-0000-000000000001";

async function main() {
  const isProduction =
    process.env.NODE_ENV === "production" || process.env.APP_ENV === "production";
  const enableBootstrap = process.env.ENABLE_PLATFORM_BOOTSTRAP === "true";
  const bootstrapSecret = process.env.PLATFORM_BOOTSTRAP_SECRET;

  if (isProduction && !enableBootstrap) {
    console.error(
      "ERROR: Platform admin bootstrap is disabled in production. Set ENABLE_PLATFORM_BOOTSTRAP=true to enable.",
    );
    process.exit(1);
  }

  if (!bootstrapSecret || bootstrapSecret.length < 32) {
    console.error(
      "ERROR: PLATFORM_BOOTSTRAP_SECRET environment variable is required and must be at least 32 characters long.",
    );
    process.exit(1);
  }

  const prisma = new PrismaClient();

  try {
    // Set tenant context for system tenant under FORCE RLS
    await prisma.$executeRaw`SELECT set_config('app.current_school_id', ${SYSTEM_TENANT_ID}, true)`;

    // Check if platform admin already exists
    const existingPlatformAdmin = await prisma.userRole.findFirst({
      where: {
        schoolId: SYSTEM_TENANT_ID,
        role: {
          slug: "platform_admin",
        },
      },
      include: {
        user: true,
      },
    });

    if (existingPlatformAdmin) {
      console.error(
        `ERROR: Platform administrator already exists (${existingPlatformAdmin.user.email}). Bootstrap refused.`,
      );
      process.exit(1);
    }

    // Resolve platform_admin role
    const platformAdminRole = await prisma.role.findFirst({
      where: {
        schoolId: SYSTEM_TENANT_ID,
        slug: "platform_admin",
      },
    });

    if (!platformAdminRole) {
      console.error(
        "ERROR: platform_admin role not found under system tenant. Run migrations and seeding first.",
      );
      process.exit(1);
    }

    const email =
      process.env.PLATFORM_ADMIN_EMAIL?.trim().toLowerCase() ||
      "platform.admin@progresseye.internal";
    const oneTimePassword = `Pe!${crypto.randomBytes(18).toString("base64url")}`;

    const passwordHash = await argon2.hash(oneTimePassword, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
    });

    const user = await prisma.user.create({
      data: {
        schoolId: SYSTEM_TENANT_ID,
        email,
        passwordHash,
        firstName: "Platform",
        lastName: "Administrator",
        isActive: true,
        mustChangePassword: true,
        isTwoFactorEnabled: false, // Forced 2FA enrollment on initial login
      },
    });

    await prisma.userRole.create({
      data: {
        schoolId: SYSTEM_TENANT_ID,
        userId: user.id,
        roleId: platformAdminRole.id,
      },
    });

    // Write audit log entry (raw execute without RETURNING)
    await prisma.$executeRaw`
      INSERT INTO "platform_audit_logs" (
        "id",
        "actor_user_id",
        "action",
        "resource",
        "resource_id",
        "payload",
        "client_ip_hash",
        "user_agent",
        "created_at"
      ) VALUES (
        gen_random_uuid(),
        ${user.id}::uuid,
        'PLATFORM_ADMIN_BOOTSTRAP',
        'user',
        ${user.id},
        ${JSON.stringify({ email, action: "PLATFORM_ADMIN_BOOTSTRAP" })}::jsonb,
        NULL,
        'CLI bootstrap-platform-admin.ts',
        CURRENT_TIMESTAMP(3)
      )
    `;

    console.log("==========================================================");
    console.log("PLATFORM ADMINISTRATOR BOOTSTRAPPED SUCCESSFULLY");
    console.log("==========================================================");
    console.log(`User ID:           ${user.id}`);
    console.log(`Email:             ${email}`);
    console.log(`One-Time Password: ${oneTimePassword}`);
    console.log("Note: 2FA enrollment is mandatory upon first login.");
    console.log("Save this password now; it will NOT be displayed again.");
    console.log("==========================================================");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("FATAL: Bootstrap script encountered an error:", err);
  process.exit(1);
});
