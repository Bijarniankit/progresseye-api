import { PrismaClient } from "@prisma/client";
import { uuidv7 } from "uuidv7";
import {
  BUILT_IN_ROLES,
  PERMISSIONS_CATALOG,
} from "../src/modules/identity/domain/permissions.catalog";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding Phase 11 multi-tenancy & Phase 13 authorization foundation...");

  // 1. Seed Global Permissions Catalog
  console.log("Seeding global permissions catalog...");
  for (const item of PERMISSIONS_CATALOG) {
    await prisma.permission.upsert({
      where: { code: item.code },
      update: {
        module: item.module,
        description: item.description,
      },
      create: {
        code: item.code,
        module: item.module,
        description: item.description,
      },
    });
  }
  console.log(`Global permissions seeded: ${PERMISSIONS_CATALOG.length} permissions.`);

  // 2. Demo School Root
  const schoolId = uuidv7();
  const school = await prisma.school.upsert({
    where: { id: schoolId },
    update: {},
    create: {
      id: schoolId,
      name: "Heritage Academy Demo School",
      slug: "heritage-demo",
      isActive: true,
    },
  });
  console.log(`Created/Verified Demo School: ${school.name} (${school.id})`);

  // 3. Demo Academic Year
  const yearId = uuidv7();
  const academicYear = await prisma.academicYear.create({
    data: {
      id: yearId,
      schoolId: school.id,
      name: "2026-2027",
      startDate: new Date("2026-04-01"),
      endDate: new Date("2027-03-31"),
      isCurrent: true,
    },
  });
  console.log(`Created Academic Year: ${academicYear.name} (${academicYear.id})`);

  // 4. Seed 13 Built-in Roles for the Demo School
  console.log(`Seeding 13 built-in roles for school: ${school.name}...`);
  const allPermissions = await prisma.permission.findMany();
  const permMap = new Map(allPermissions.map((p) => [p.code, p.id]));

  let principalRoleId = "";
  for (const builtIn of BUILT_IN_ROLES) {
    let role = await prisma.role.findFirst({
      where: { schoolId: school.id, slug: builtIn.slug },
    });

    if (!role) {
      role = await prisma.role.create({
        data: {
          schoolId: school.id,
          name: builtIn.name,
          slug: builtIn.slug,
          description: builtIn.description,
          isSystem: true,
        },
      });
    } else {
      role = await prisma.role.update({
        where: { id: role.id },
        data: {
          name: builtIn.name,
          description: builtIn.description,
          isSystem: true,
        },
      });
    }

    if (builtIn.slug === "principal") {
      principalRoleId = role.id;
    }

    for (const code of builtIn.permissions) {
      const permId = permMap.get(code);
      if (permId) {
        await prisma.rolePermission.upsert({
          where: {
            schoolId_roleId_permissionId: {
              schoolId: school.id,
              roleId: role.id,
              permissionId: permId,
            },
          },
          update: {},
          create: {
            schoolId: school.id,
            roleId: role.id,
            permissionId: permId,
          },
        });
      }
    }
  }
  console.log(`Built-in roles seeded for ${school.name}.`);

  // 5. Demo Admin User
  const userId = uuidv7();
  const user = await prisma.user.create({
    data: {
      id: userId,
      schoolId: school.id,
      email: "principal@heritage-demo.progresseye.com",
      firstName: "Heritage",
      lastName: "Principal",
      isActive: true,
    },
  });
  console.log(`Created Demo Admin User: ${user.email} (${user.id})`);

  // 6. Assign Principal Role to Demo Admin User
  if (principalRoleId) {
    await prisma.userRole.create({
      data: {
        schoolId: school.id,
        userId: user.id,
        roleId: principalRoleId,
      },
    });
    console.log(`Assigned Principal role to ${user.email}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
