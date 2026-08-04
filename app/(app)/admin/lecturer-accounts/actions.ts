"use server";

import { randomBytes } from "crypto";
import argon2 from "argon2";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma, BULK_TRANSACTION_OPTIONS } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { audit } from "@/lib/audit";

function generateTempPassword(): string {
  return randomBytes(9).toString("base64url");
}

export interface GeneratedLecturerAccount {
  staffNo: string;
  fullName: string;
  phoneNumber: string;
  tempPassword: string;
}

// One transaction for the whole department: either every eligible
// lecturer (has a phoneNumber, no account yet) gets one, or none do.
// Mirrors generateAccountsForClass (admin/student-accounts/actions.ts) —
// same hash-before-transaction pattern (argon2id is deliberately slow;
// see CLAUDE.md's dedicated convention on this).
export async function generateAccountsForDepartment(
  departmentId: string | null
): Promise<{ created: GeneratedLecturerAccount[]; skippedNoPhone: number }> {
  const admin = await requirePermission("user.manage");

  const lecturers = await prisma.lecturer.findMany({
    where: { departmentId, userId: null },
  });
  const eligible = lecturers.filter((l) => !!l.phoneNumber);
  const skippedNoPhone = lecturers.length - eligible.length;
  if (eligible.length === 0) {
    return { created: [], skippedNoPhone };
  }

  const lecturerRole = await prisma.role.findUniqueOrThrow({
    where: { name: "LECTURER" },
  });

  const toCreate = await Promise.all(
    eligible.map(async (lecturer) => {
      const tempPassword = generateTempPassword();
      const passwordHash = await argon2.hash(tempPassword, {
        type: argon2.argon2id,
      });
      return { lecturer, tempPassword, passwordHash };
    })
  );

  const created: (GeneratedLecturerAccount & { userId: string })[] = [];

  await prisma.$transaction(async (tx) => {
    for (const { lecturer, tempPassword, passwordHash } of toCreate) {
      const user = await tx.user.create({
        data: {
          username: lecturer.phoneNumber!,
          email: null,
          fullName: lecturer.fullName,
          passwordHash,
          mustChangePw: true,
          userRoles: { create: { roleId: lecturerRole.id } },
        },
      });
      await tx.lecturer.update({
        where: { id: lecturer.id },
        data: { userId: user.id },
      });

      created.push({
        staffNo: lecturer.staffNo,
        fullName: lecturer.fullName,
        phoneNumber: lecturer.phoneNumber!,
        tempPassword,
        userId: user.id,
      });
    }
  }, BULK_TRANSACTION_OPTIONS);

  for (const account of created) {
    await audit({
      userId: admin.id,
      action: "LECTURER_ACCOUNT_GENERATED",
      entity: "User",
      entityId: account.userId,
      newValue: { staffNo: account.staffNo, phoneNumber: account.phoneNumber },
    });
  }

  revalidatePath("/admin/lecturers");
  return {
    created: created.map(({ staffNo, fullName, phoneNumber, tempPassword }) => ({
      staffNo,
      fullName,
      phoneNumber,
      tempPassword,
    })),
    skippedNoPhone,
  };
}

export async function generateAccountForLecturer(
  lecturerId: string
): Promise<{ tempPassword: string }> {
  const admin = await requirePermission("user.manage");

  const lecturer = await prisma.lecturer.findUniqueOrThrow({
    where: { id: lecturerId },
  });
  if (lecturer.userId) {
    throw new Error("ALREADY_HAS_ACCOUNT");
  }
  if (!lecturer.phoneNumber) {
    throw new Error("NO_PHONE_NUMBER");
  }

  const tempPassword = generateTempPassword();
  const passwordHash = await argon2.hash(tempPassword, {
    type: argon2.argon2id,
  });

  const lecturerRole = await prisma.role.findUniqueOrThrow({
    where: { name: "LECTURER" },
  });

  let user;
  try {
    user = await prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          username: lecturer.phoneNumber!,
          email: null,
          fullName: lecturer.fullName,
          passwordHash,
          mustChangePw: true,
          userRoles: { create: { roleId: lecturerRole.id } },
        },
      });
      await tx.lecturer.update({
        where: { id: lecturer.id },
        data: { userId: newUser.id },
      });
      return newUser;
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new Error("PHONE_NUMBER_TAKEN");
    }
    throw error;
  }

  await audit({
    userId: admin.id,
    action: "LECTURER_ACCOUNT_GENERATED",
    entity: "User",
    entityId: user.id,
    newValue: { staffNo: lecturer.staffNo, phoneNumber: lecturer.phoneNumber },
  });

  revalidatePath("/admin/lecturers");
  return { tempPassword };
}

export async function resetLecturerPassword(
  lecturerId: string
): Promise<{ tempPassword: string }> {
  const admin = await requirePermission("user.manage");

  const lecturer = await prisma.lecturer.findUniqueOrThrow({
    where: { id: lecturerId },
  });
  if (!lecturer.userId) {
    throw new Error("NO_ACCOUNT");
  }

  const tempPassword = generateTempPassword();
  const passwordHash = await argon2.hash(tempPassword, {
    type: argon2.argon2id,
  });

  await prisma.user.update({
    where: { id: lecturer.userId },
    data: {
      passwordHash,
      mustChangePw: true,
      failedLogins: 0,
      lockedUntil: null,
    },
  });

  await audit({
    userId: admin.id,
    action: "LECTURER_PASSWORD_RESET",
    entity: "User",
    entityId: lecturer.userId,
    newValue: { staffNo: lecturer.staffNo },
  });

  revalidatePath("/admin/lecturers");
  return { tempPassword };
}
