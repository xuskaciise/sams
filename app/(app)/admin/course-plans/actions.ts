"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/auth";

export async function addCourseToPlan(
  classId: string,
  courseId: string,
  semesterNumber: number
) {
  await requireRole("ADMIN");

  try {
    await prisma.classCoursePlan.create({
      data: { classId, courseId, semesterNumber },
    });
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
  sourceClassId: string,
  semesterNumber: number
): Promise<{ copied: number }> {
  await requireRole("ADMIN");

  if (targetClassId === sourceClassId) {
    throw new Error("SAME_CLASS");
  }

  const [sourcePlans, targetPlans] = await Promise.all([
    prisma.classCoursePlan.findMany({
      where: { classId: sourceClassId, semesterNumber },
    }),
    prisma.classCoursePlan.findMany({
      where: { classId: targetClassId, semesterNumber },
    }),
  ]);
  const targetCourseIds = new Set(targetPlans.map((p) => p.courseId));

  // Filter out courses already in the target's plan BEFORE the transaction:
  // catching a unique-constraint violation mid-transaction doesn't let
  // Postgres carry on to the next statement — the whole transaction is
  // aborted from that point, even though the JS catch block swallows the
  // error. Pre-checking avoids ever hitting that failure.
  const toCopy = sourcePlans.filter((plan) => !targetCourseIds.has(plan.courseId));

  if (toCopy.length > 0) {
    await prisma.$transaction(
      toCopy.map((plan) =>
        prisma.classCoursePlan.create({
          data: {
            classId: targetClassId,
            courseId: plan.courseId,
            semesterNumber,
          },
        })
      )
    );
  }

  revalidatePath("/admin/curriculum");
  return { copied: toCopy.length };
}
