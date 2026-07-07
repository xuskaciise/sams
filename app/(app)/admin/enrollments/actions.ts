"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { autoEnrollStudentIntoClassCourses, auditAutoEnrollments } from "@/lib/enrollment";
import {
  enrollmentSchema,
  type EnrollmentInput,
  transferSchema,
  type TransferInput,
} from "./schema";

export async function createEnrollment(input: EnrollmentInput) {
  const admin = await requireRole("ADMIN");
  const data = enrollmentSchema.parse(input);

  const student = await prisma.student.findUniqueOrThrow({
    where: { id: data.studentId },
  });

  try {
    await prisma.$transaction(async (tx) => {
      const existingActive = await tx.studentCourseEnrollment.findFirst({
        where: {
          studentId: data.studentId,
          courseId: data.courseId,
          semesterId: data.semesterId,
          status: "ACTIVE",
        },
      });
      if (existingActive) {
        throw new Error("ALREADY_ENROLLED");
      }

      await tx.studentCourseEnrollment.create({
        data: {
          studentId: data.studentId,
          courseId: data.courseId,
          semesterId: data.semesterId,
          classId: student.classId,
        },
      });
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new Error("ALREADY_ENROLLED");
    }
    throw error;
  }

  await audit({
    userId: admin.id,
    action: "ENROLLMENT_CREATED",
    entity: "StudentCourseEnrollment",
    newValue: data,
  });

  revalidatePath("/admin/enrollments");
}

export async function dropEnrollment(id: string) {
  const admin = await requireRole("ADMIN");

  await prisma.studentCourseEnrollment.update({
    where: { id },
    data: { status: "DROPPED" },
  });

  await audit({
    userId: admin.id,
    action: "ENROLLMENT_DROPPED",
    entity: "StudentCourseEnrollment",
    entityId: id,
  });

  revalidatePath("/admin/enrollments");
}

export async function restoreEnrollment(id: string) {
  const admin = await requireRole("ADMIN");

  const enrollment = await prisma.studentCourseEnrollment.findUniqueOrThrow({
    where: { id },
  });
  if (enrollment.status !== "DROPPED") {
    throw new Error("NOT_DROPPED");
  }

  try {
    await prisma.studentCourseEnrollment.update({
      where: { id },
      data: { status: "ACTIVE" },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new Error("ALREADY_ENROLLED");
    }
    throw error;
  }

  await audit({
    userId: admin.id,
    action: "ENROLLMENT_RESTORED",
    entity: "StudentCourseEnrollment",
    entityId: id,
  });

  revalidatePath("/admin/enrollments");
}

export async function transferEnrollment(id: string, input: TransferInput) {
  const admin = await requireRole("ADMIN");
  const data = transferSchema.parse(input);

  const oldEnrollment = await prisma.studentCourseEnrollment.findUniqueOrThrow(
    { where: { id } }
  );

  if (oldEnrollment.status !== "ACTIVE") {
    throw new Error("NOT_ACTIVE");
  }

  const autoEnrolled = await prisma.$transaction(async (tx) => {
    // Demote the old row to TRANSFERRED first — the (student, course,
    // semester, status) unique constraint rejects two ACTIVE rows at once,
    // so the new ACTIVE enrollment can't be created while this is still ACTIVE.
    await tx.studentCourseEnrollment.update({
      where: { id: oldEnrollment.id },
      data: { status: "TRANSFERRED" },
    });

    const newEnrollment = await tx.studentCourseEnrollment.create({
      data: {
        studentId: oldEnrollment.studentId,
        courseId: oldEnrollment.courseId,
        semesterId: oldEnrollment.semesterId,
        classId: data.newClassId,
      },
    });

    await tx.studentCourseEnrollment.update({
      where: { id: oldEnrollment.id },
      data: { transferredToId: newEnrollment.id },
    });

    await tx.student.update({
      where: { id: oldEnrollment.studentId },
      data: { classId: data.newClassId },
    });

    // The student moved into a new class — pick up any other courses
    // assigned to that class in an active semester too, not just the one
    // course being explicitly transferred.
    return autoEnrollStudentIntoClassCourses(
      tx,
      oldEnrollment.studentId,
      data.newClassId
    );
  });

  await audit({
    userId: admin.id,
    action: "ENROLLMENT_TRANSFERRED",
    entity: "StudentCourseEnrollment",
    entityId: id,
    newValue: { newClassId: data.newClassId },
  });
  await auditAutoEnrollments(admin.id, autoEnrolled);

  revalidatePath("/admin/enrollments");
}
