"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { audit } from "@/lib/audit";
import {
  autoEnrollStudentIntoClassCourses,
  auditAutoEnrollments,
  type AutoEnrolledRecord,
} from "@/lib/enrollment";
import {
  studentRegistrationSchema,
  type StudentRegistrationInput,
  studentPhoneNumberSchema,
  type StudentPhoneNumberInput,
} from "./schema";

export async function registerStudent(input: StudentRegistrationInput) {
  const admin = await requirePermission("students.manage");
  const data = studentRegistrationSchema.parse(input);

  let student;
  let autoEnrolled: AutoEnrolledRecord[];
  try {
    ({ student, autoEnrolled } = await prisma.$transaction(async (tx) => {
      const student = await tx.student.create({
        data: {
          studentNo: data.studentNo,
          fullName: data.fullName,
          gender: data.gender,
          classId: data.classId,
          phoneNumber: data.phoneNumber || null,
        },
      });
      const autoEnrolled = await autoEnrollStudentIntoClassCourses(
        tx,
        student.id,
        student.classId
      );
      return { student, autoEnrolled };
    }));
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new Error("STUDENT_NO_TAKEN");
    }
    throw error;
  }

  await audit({
    userId: admin.id,
    action: "STUDENT_REGISTERED",
    entity: "Student",
    entityId: student.id,
    newValue: {
      studentNo: student.studentNo,
      fullName: student.fullName,
      classId: student.classId,
    },
  });
  await auditAutoEnrollments(admin.id, autoEnrolled);

  revalidatePath("/admin/students");
  return student;
}

// A student registered before the phoneNumber field existed (i.e. almost
// every student already in the system) has no other way to ever get one
// set — there is no general student-edit form. Deliberately narrow: this
// is the ONLY field editable after registration, purely to make WhatsApp
// notifications (best-effort, unofficial, see lib/whatsapp-notify.ts)
// usable for existing students, not a general-purpose edit endpoint.
export async function updateStudentPhoneNumber(
  studentId: string,
  input: StudentPhoneNumberInput
) {
  const admin = await requirePermission("students.manage");
  const data = studentPhoneNumberSchema.parse(input);

  const before = await prisma.student.findUniqueOrThrow({
    where: { id: studentId },
  });

  const student = await prisma.student.update({
    where: { id: studentId },
    data: { phoneNumber: data.phoneNumber || null },
  });

  await audit({
    userId: admin.id,
    action: "STUDENT_PHONE_UPDATED",
    entity: "Student",
    entityId: student.id,
    oldValue: { phoneNumber: before.phoneNumber },
    newValue: { phoneNumber: student.phoneNumber },
  });

  revalidatePath("/admin/students");
  return student;
}
