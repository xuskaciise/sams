"use server";

import { randomBytes } from "crypto";
import argon2 from "argon2";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { audit } from "@/lib/audit";

function generateTempPassword(): string {
  return randomBytes(9).toString("base64url");
}

function syntheticEmail(studentNo: string): string {
  return `${studentNo}@students.sams.local`;
}

export interface GeneratedAccount {
  studentNo: string;
  fullName: string;
  tempPassword: string;
}

// One transaction for the whole class: either every student without an
// account gets one, or none do.
export async function generateAccountsForClass(
  classId: string
): Promise<{ created: GeneratedAccount[] }> {
  const admin = await requirePermission("students.manage");

  const students = await prisma.student.findMany({
    where: { classId, userId: null },
  });
  if (students.length === 0) {
    return { created: [] };
  }

  const created: (GeneratedAccount & { userId: string })[] = [];
  const studentRole = await prisma.role.findUniqueOrThrow({
    where: { name: "STUDENT" },
  });

  await prisma.$transaction(async (tx) => {
    for (const student of students) {
      const tempPassword = generateTempPassword();
      const passwordHash = await argon2.hash(tempPassword, {
        type: argon2.argon2id,
      });

      const user = await tx.user.create({
        data: {
          username: student.studentNo,
          email: syntheticEmail(student.studentNo),
          fullName: student.fullName,
          passwordHash,
          mustChangePw: true,
          userRoles: { create: { roleId: studentRole.id } },
        },
      });
      await tx.student.update({
        where: { id: student.id },
        data: { userId: user.id },
      });

      created.push({
        studentNo: student.studentNo,
        fullName: student.fullName,
        tempPassword,
        userId: user.id,
      });
    }
  });

  for (const account of created) {
    await audit({
      userId: admin.id,
      action: "STUDENT_ACCOUNT_GENERATED",
      entity: "User",
      entityId: account.userId,
      newValue: { studentNo: account.studentNo },
    });
  }

  revalidatePath("/admin/students");
  return {
    created: created.map(({ studentNo, fullName, tempPassword }) => ({
      studentNo,
      fullName,
      tempPassword,
    })),
  };
}

export async function generateAccountForStudent(
  studentId: string
): Promise<{ tempPassword: string }> {
  const admin = await requirePermission("students.manage");

  const student = await prisma.student.findUniqueOrThrow({
    where: { id: studentId },
  });
  if (student.userId) {
    throw new Error("ALREADY_HAS_ACCOUNT");
  }

  const tempPassword = generateTempPassword();
  const passwordHash = await argon2.hash(tempPassword, {
    type: argon2.argon2id,
  });

  const studentRole = await prisma.role.findUniqueOrThrow({
    where: { name: "STUDENT" },
  });

  const user = await prisma.$transaction(async (tx) => {
    const newUser = await tx.user.create({
      data: {
        username: student.studentNo,
        email: syntheticEmail(student.studentNo),
        fullName: student.fullName,
        passwordHash,
        mustChangePw: true,
        userRoles: { create: { roleId: studentRole.id } },
      },
    });
    await tx.student.update({
      where: { id: student.id },
      data: { userId: newUser.id },
    });
    return newUser;
  });

  await audit({
    userId: admin.id,
    action: "STUDENT_ACCOUNT_GENERATED",
    entity: "User",
    entityId: user.id,
    newValue: { studentNo: student.studentNo },
  });

  revalidatePath("/admin/students");
  return { tempPassword };
}

export async function resetStudentPassword(
  studentId: string
): Promise<{ tempPassword: string }> {
  const admin = await requirePermission("students.manage");

  const student = await prisma.student.findUniqueOrThrow({
    where: { id: studentId },
  });
  if (!student.userId) {
    throw new Error("NO_ACCOUNT");
  }

  const tempPassword = generateTempPassword();
  const passwordHash = await argon2.hash(tempPassword, {
    type: argon2.argon2id,
  });

  await prisma.user.update({
    where: { id: student.userId },
    data: {
      passwordHash,
      mustChangePw: true,
      failedLogins: 0,
      lockedUntil: null,
    },
  });

  await audit({
    userId: admin.id,
    action: "STUDENT_PASSWORD_RESET",
    entity: "User",
    entityId: student.userId,
    newValue: { studentNo: student.studentNo },
  });

  revalidatePath("/admin/students");
  return { tempPassword };
}
