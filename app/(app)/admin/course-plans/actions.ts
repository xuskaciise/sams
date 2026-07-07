"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/auth";

export async function addCourseToPlan(classId: string, courseId: string) {
  await requireRole("ADMIN");

  try {
    await prisma.classCoursePlan.create({ data: { classId, courseId } });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new Error("ALREADY_IN_PLAN");
    }
    throw error;
  }

  revalidatePath("/admin/curriculum");
}

export async function removeCourseFromPlan(planId: string) {
  await requireRole("ADMIN");

  await prisma.classCoursePlan.delete({ where: { id: planId } });

  revalidatePath("/admin/curriculum");
}

export async function copyPlanFromClass(
  targetClassId: string,
  sourceClassId: string
): Promise<{ copied: number }> {
  await requireRole("ADMIN");

  if (targetClassId === sourceClassId) {
    throw new Error("SAME_CLASS");
  }

  const sourcePlans = await prisma.classCoursePlan.findMany({
    where: { classId: sourceClassId },
  });

  let copied = 0;
  await prisma.$transaction(async (tx) => {
    for (const plan of sourcePlans) {
      try {
        await tx.classCoursePlan.create({
          data: { classId: targetClassId, courseId: plan.courseId },
        });
        copied++;
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          continue; // already in the target class's plan
        }
        throw error;
      }
    }
  });

  revalidatePath("/admin/curriculum");
  return { copied };
}
