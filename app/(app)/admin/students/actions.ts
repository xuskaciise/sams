"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { audit } from "@/lib/audit";
import {
  studentRegistrationSchema,
  type StudentRegistrationInput,
} from "./schema";

export async function registerStudent(input: StudentRegistrationInput) {
  const admin = await requireRole("ADMIN");
  const data = studentRegistrationSchema.parse(input);

  let student;
  try {
    student = await prisma.student.create({
      data: {
        studentNo: data.studentNo,
        fullName: data.fullName,
        gender: data.gender,
        classId: data.classId,
      },
    });
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

  revalidatePath("/admin/students");
  return student;
}
