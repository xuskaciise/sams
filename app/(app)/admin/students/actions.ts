"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { audit } from "@/lib/audit";
import {
  autoEnrollStudentIntoClassCourses,
  auditAutoEnrollments,
  type AutoEnrolledRecord,
} from "@/lib/enrollment";
import {
  studentRegistrationSchema,
  type StudentRegistrationInput,
} from "./schema";

export async function registerStudent(input: StudentRegistrationInput) {
  const admin = await requireRole("ADMIN");
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
