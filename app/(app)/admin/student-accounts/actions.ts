"use server";

import argon2 from "argon2";
import { revalidatePath } from "next/cache";
import { prisma, BULK_TRANSACTION_OPTIONS } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { emailStudentCredentials } from "@/lib/email-notify";

// The ONLY student temp-password source: the last 4 digits of the
// student's own phoneNumber on file (e.g. "+252634001234" -> "1234"),
// never a random string. Phone number is therefore REQUIRED before an
// account can be generated or reset — see the NO_PHONE_NUMBER guards
// below. Strips non-digit characters first so a leading "+" (allowed by
// PHONE_NUMBER_PATTERN, lib/whatsapp-notify.ts) never ends up counted.
function passwordFromPhoneNumber(phoneNumber: string): string {
  return phoneNumber.replace(/\D/g, "").slice(-4);
}

function syntheticEmail(studentNo: string): string {
  return `${studentNo}@students.sams.local`;
}

export interface GeneratedAccount {
  studentNo: string;
  fullName: string;
  tempPassword: string;
}

export interface SkippedAccount {
  studentNo: string;
  fullName: string;
  reason: string;
}

// One transaction for the whole class: either every ELIGIBLE student
// (has a phoneNumber, no account yet) gets one, or none do. A student
// with no phoneNumber on file is skipped — reported per-student in
// `skipped` (not just a count) rather than failing the whole batch or
// falling back to a random password.
export async function generateAccountsForClass(
  classId: string
): Promise<{ created: GeneratedAccount[]; skipped: SkippedAccount[] }> {
  const admin = await requirePermission("students.manage");

  const students = await prisma.student.findMany({
    where: { classId, userId: null },
  });
  const eligible = students.filter((s) => !!s.phoneNumber);
  const skipped: SkippedAccount[] = students
    .filter((s) => !s.phoneNumber)
    .map((s) => ({
      studentNo: s.studentNo,
      fullName: s.fullName,
      reason: "Skipped: no phone number",
    }));
  if (eligible.length === 0) {
    return { created: [], skipped };
  }

  const studentRole = await prisma.role.findUniqueOrThrow({
    where: { name: "STUDENT" },
  });

  // argon2id is deliberately slow (CPU/memory-hard) — hashing every
  // student's password INSIDE the transaction below used to blow past
  // Prisma's interactive-transaction timeout (default 5s) for any class
  // with more than a handful of students, aborting the whole batch with
  // "Transaction already closed". Hashing is pure CPU work with no DB
  // lock needed, so it happens up front; the transaction then only does
  // fast DB writes. (Deriving the password itself is instant — only what
  // gets hashed changed, not why hashing happens outside the transaction.)
  const toCreate = await Promise.all(
    eligible.map(async (student) => {
      const tempPassword = passwordFromPhoneNumber(student.phoneNumber!);
      const passwordHash = await argon2.hash(tempPassword, {
        type: argon2.argon2id,
      });
      return { student, tempPassword, passwordHash };
    })
  );

  const created: (GeneratedAccount & {
    userId: string;
    studentId: string;
    email: string | null;
  })[] = [];

  await prisma.$transaction(async (tx) => {
    for (const { student, tempPassword, passwordHash } of toCreate) {
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
        studentId: student.id,
        email: student.email,
      });
    }
  }, BULK_TRANSACTION_OPTIONS);

  for (const account of created) {
    await audit({
      userId: admin.id,
      action: "STUDENT_ACCOUNT_GENERATED",
      entity: "User",
      entityId: account.userId,
      newValue: { studentNo: account.studentNo },
    });
  }

  // Fire-and-forget: email the credentials to every student who has a real
  // email on file. Never throws; a student with no email just isn't
  // emailed and the CSV / one-time reveal below is the fallback.
  await Promise.all(
    created.map((a) =>
      emailStudentCredentials({
        studentId: a.studentId,
        studentNo: a.studentNo,
        fullName: a.fullName,
        email: a.email,
        username: a.studentNo,
        tempPassword: a.tempPassword,
      })
    )
  );

  revalidatePath("/admin/students");
  return {
    created: created.map(({ studentNo, fullName, tempPassword }) => ({
      studentNo,
      fullName,
      tempPassword,
    })),
    skipped,
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
  if (!student.phoneNumber) {
    throw new Error("NO_PHONE_NUMBER");
  }

  const tempPassword = passwordFromPhoneNumber(student.phoneNumber);
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

  // Fire-and-forget credential email (real email on file only).
  await emailStudentCredentials({
    studentId: student.id,
    studentNo: student.studentNo,
    fullName: student.fullName,
    email: student.email,
    username: student.studentNo,
    tempPassword,
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
  // The phone-derived password is the ONLY source now, so a reset needs
  // a current phone number just as much as first generation does — and
  // always uses whatever number is on file NOW (a since-changed number's
  // NEW last 4 digits), never a cached value from account creation.
  if (!student.phoneNumber) {
    throw new Error("NO_PHONE_NUMBER");
  }

  const tempPassword = passwordFromPhoneNumber(student.phoneNumber);
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
