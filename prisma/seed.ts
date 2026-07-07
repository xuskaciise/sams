import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";

const prisma = new PrismaClient();

const ADMIN_EMAIL = "admin@sams.local";
const ADMIN_TEMP_PASSWORD = "ChangeMe123!";

async function main() {
  const passwordHash = await argon2.hash(ADMIN_TEMP_PASSWORD, {
    type: argon2.argon2id,
  });

  // update: {} — never overwrite an existing admin's real password on re-seed.
  const admin = await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    update: {},
    create: {
      email: ADMIN_EMAIL,
      username: ADMIN_EMAIL,
      passwordHash,
      role: "ADMIN",
      fullName: "System Administrator",
      mustChangePw: true,
    },
  });

  console.log(`Seeded admin user: ${admin.email}`);

  const assessmentTypes = [
    "Quiz",
    "Assignment",
    "Lab",
    "Presentation",
    "Project",
    "Class Work",
  ];

  for (const name of assessmentTypes) {
    await prisma.assessmentType.upsert({
      where: { name },
      update: {},
      create: { name },
    });
  }

  console.log(`Seeded assessment types: ${assessmentTypes.join(", ")}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
