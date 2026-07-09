import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
import {
  PERMISSIONS,
  SYSTEM_ROLES,
  SYSTEM_ROLE_DESCRIPTIONS,
  DEFAULT_ROLE_GRANTS,
} from "../lib/permissions";

const prisma = new PrismaClient();

const ADMIN_EMAIL = "admin@sams.local";
const ADMIN_TEMP_PASSWORD = "ChangeMe123!";

async function main() {
  // Permission catalog — upsert so re-seeding syncs descriptions/categories
  // without touching grants. Never deletes: removing a permission is a
  // migration, not a seed concern.
  for (const p of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: p.key },
      update: { description: p.description, category: p.category },
      create: { key: p.key, description: p.description, category: p.category },
    });
  }
  console.log(`Seeded ${PERMISSIONS.length} permissions`);

  // System roles + their default grants. Grants are only CREATED here
  // (createMany + skipDuplicates semantics via upsert-per-pair) — an
  // admin's later edits to a system role's permissions are preserved on
  // re-seed. Fresh databases get exactly DEFAULT_ROLE_GRANTS.
  for (const name of SYSTEM_ROLES) {
    const role = await prisma.role.upsert({
      where: { name },
      update: { isSystem: true },
      create: {
        name,
        description: SYSTEM_ROLE_DESCRIPTIONS[name],
        isSystem: true,
      },
    });

    const existingGrants = await prisma.rolePermission.count({
      where: { roleId: role.id },
    });
    if (existingGrants === 0) {
      const perms = await prisma.permission.findMany({
        where: { key: { in: DEFAULT_ROLE_GRANTS[name] } },
      });
      await prisma.rolePermission.createMany({
        data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })),
      });
      console.log(`Granted ${perms.length} permissions to ${name}`);
    }
  }

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
      fullName: "System Administrator",
      mustChangePw: true,
    },
  });

  const adminRole = await prisma.role.findUniqueOrThrow({
    where: { name: "ADMIN" },
  });
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: admin.id, roleId: adminRole.id } },
    update: {},
    create: { userId: admin.id, roleId: adminRole.id },
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
