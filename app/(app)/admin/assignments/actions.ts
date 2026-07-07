"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import {
  autoEnrollClassIntoAssignment,
  auditAutoEnrollments,
  type AutoEnrolledRecord,
} from "@/lib/enrollment";
import { assignmentSchema, type AssignmentInput } from "./schema";

export async function createAssignment(input: AssignmentInput) {
  const admin = await requireRole("ADMIN");
  const data = assignmentSchema.parse(input);

  let autoEnrolled: AutoEnrolledRecord[];
  try {
    autoEnrolled = await prisma.$transaction(async (tx) => {
      const assignment = await tx.lecturerCourseAssignment.create({ data });
      return autoEnrollClassIntoAssignment(tx, assignment);
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new Error("DUPLICATE_ASSIGNMENT");
    }
    throw error;
  }
  await auditAutoEnrollments(admin.id, autoEnrolled);

  revalidatePath("/admin/curriculum");
  revalidatePath("/admin/students");
}

export async function deleteAssignment(id: string) {
  await requireRole("ADMIN");
  await prisma.lecturerCourseAssignment.delete({ where: { id } });
  revalidatePath("/admin/curriculum");
}
