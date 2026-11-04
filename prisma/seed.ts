import { PrismaClient } from "@prisma/client";
import { uuidv7 } from "uuidv7";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding Phase 11 multi-tenancy foundation...");

  // 1. Demo School Root
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

  // 2. Demo Academic Year
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

  // 3. Demo Admin User
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
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
