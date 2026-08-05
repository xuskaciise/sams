"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { audit } from "@/lib/audit";
import {
  lecturerRegistrationSchema,
  type LecturerRegistrationInput,
  lecturerPhoneNumberSchema,
  type LecturerPhoneNumberInput,
  lecturerDepartmentSchema,
  type LecturerDepartmentInput,
} from "./schema";

// Mirrors registerStudent (admin/students/actions.ts): creates ONLY the
// Lecturer profile row, no login account — accounts are generated later,
// per-lecturer or by department, from the standalone Lecturer Accounts
// page.
export async function registerLecturer(input: LecturerRegistrationInput) {
  const admin = await requirePermission("user.manage");
  const data = lecturerRegistrationSchema.parse(input);

  let lecturer;
  try {
    lecturer = await prisma.lecturer.create({
      data: {
        staffNo: data.staffNo,
        fullName: data.fullName,
        phoneNumber: data.phoneNumber,
        title: data.title || null,
        departmentId: data.departmentId || null,
      },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const target = (error.meta?.target as string[] | undefined) ?? [];
      if (target.includes("phone_number")) {
        throw new Error("PHONE_NUMBER_TAKEN");
      }
      throw new Error("STAFF_NO_TAKEN");
    }
    throw error;
  }

  await audit({
    userId: admin.id,
    action: "LECTURER_REGISTERED",
    entity: "Lecturer",
    entityId: lecturer.id,
    newValue: {
      staffNo: lecturer.staffNo,
      fullName: lecturer.fullName,
      departmentId: lecturer.departmentId,
    },
  });

  revalidatePath("/admin/lecturers");
  return lecturer;
}

// A registered lecturer's phone number is required, but typos happen —
// this is the ONLY field editable after registration besides department
// (see updateLecturerDepartment below), same narrow-single-field pattern
// as updateStudentPhoneNumber.
export async function updateLecturerPhoneNumber(
  lecturerId: string,
  input: LecturerPhoneNumberInput
) {
  const admin = await requirePermission("user.manage");
  const data = lecturerPhoneNumberSchema.parse(input);
  if (!data.phoneNumber) {
    throw new Error("PHONE_NUMBER_REQUIRED");
  }

  const before = await prisma.lecturer.findUniqueOrThrow({
    where: { id: lecturerId },
  });

  let lecturer;
  try {
    lecturer = await prisma.lecturer.update({
      where: { id: lecturerId },
      data: { phoneNumber: data.phoneNumber },
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
    action: "LECTURER_PHONE_UPDATED",
    entity: "Lecturer",
    entityId: lecturer.id,
    oldValue: { phoneNumber: before.phoneNumber },
    newValue: { phoneNumber: lecturer.phoneNumber },
  });

  revalidatePath("/admin/lecturers");
  return lecturer;
}

// A lecturer's faculty can be set later if it wasn't known at
// registration — same "fill it in later" fallback as other nullable
// profile fields in this app.
export async function updateLecturerDepartment(
  lecturerId: string,
  input: LecturerDepartmentInput
) {
  const admin = await requirePermission("user.manage");
  const data = lecturerDepartmentSchema.parse(input);

  const before = await prisma.lecturer.findUniqueOrThrow({
    where: { id: lecturerId },
  });

  const lecturer = await prisma.lecturer.update({
    where: { id: lecturerId },
    data: { departmentId: data.departmentId || null },
  });

  await audit({
    userId: admin.id,
    action: "LECTURER_DEPARTMENT_UPDATED",
    entity: "Lecturer",
    entityId: lecturer.id,
    oldValue: { departmentId: before.departmentId },
    newValue: { departmentId: lecturer.departmentId },
  });

  revalidatePath("/admin/lecturers");
  return lecturer;
}

// Lecturer has no deletedAt/soft-delete column (unlike almost every other
// reference entity in this app) — this is a genuine hard delete, which is
// only safe (and only offered) for a lecturer that has never actually
// been used: no login account generated yet (deleting the profile would
// otherwise strand that User row as a dead-end ghost account — the exact
// scenario createUser already refuses to create), and no course
// assignments (LecturerCourseAssignment.lecturerId has no onDelete
// cascade, so the DB itself would reject this anyway; checked here first
// for a clear, specific error instead of a raw FK violation). Meant for
// correcting a registration mistake (wrong staff number, duplicate entry,
// typo caught right after saving), not as a lifecycle/offboarding tool —
// an already-active lecturer is managed via Deactivate on the Users page
// instead.
export async function deleteLecturer(lecturerId: string) {
  const admin = await requirePermission("user.manage");

  const lecturer = await prisma.lecturer.findUniqueOrThrow({
    where: { id: lecturerId },
    include: { _count: { select: { assignments: true } } },
  });

  if (lecturer.userId) {
    throw new Error("HAS_ACCOUNT");
  }
  if (lecturer._count.assignments > 0) {
    throw new Error("HAS_ASSIGNMENTS");
  }

  await prisma.lecturer.delete({ where: { id: lecturerId } });

  await audit({
    userId: admin.id,
    action: "LECTURER_DELETED",
    entity: "Lecturer",
    entityId: lecturerId,
    oldValue: { staffNo: lecturer.staffNo, fullName: lecturer.fullName },
  });

  revalidatePath("/admin/lecturers");
}
