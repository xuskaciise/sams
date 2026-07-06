"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { assignmentSchema, type AssignmentInput } from "./schema";

export async function createAssignment(input: AssignmentInput) {
  await requireRole("ADMIN");
  const data = assignmentSchema.parse(input);
  try {
    await prisma.lecturerCourseAssignment.create({ data });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new Error("DUPLICATE_ASSIGNMENT");
    }
    throw error;
  }
  revalidatePath("/admin/assignments");
}

export async function deleteAssignment(id: string) {
  await requireRole("ADMIN");
  await prisma.lecturerCourseAssignment.delete({ where: { id } });
  revalidatePath("/admin/assignments");
}
