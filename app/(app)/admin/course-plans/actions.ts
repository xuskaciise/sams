"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { audit } from "@/lib/audit";

export async function addCourseToPlan(
  classId: string,
  courseId: string,
  semesterNumber: number
) {
  await requirePermission("curriculum.manage");

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
  await requirePermission("curriculum.manage");

  await prisma.classCoursePlan.delete({ where: { id: planId } });

  revalidatePath("/admin/curriculum");
}

export async function copyPlanFromClass(
  targetClassId: string,
  sourceClassId: string,
  semesterNumber: number
): Promise<{ copied: number }> {
  await requirePermission("curriculum.manage");

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

// --- Move semester ------------------------------------------------------------
//
// Bulk-fix a data-entry mistake: re-point EVERY course planned for one class
// at `sourceSemesterNumber` to `targetSemesterNumber` in one action. Merge
// semantics with duplicate-skip — a source course already planned at the
// target level can't have its row's semesterNumber updated (that collides
// with the existing target row on @@unique([classId, semesterNumber,
// courseId])), so those source rows are DELETED and only the non-colliding
// ones are moved. Assignments/timetable slots are never touched — they key
// on the academic-calendar semesterId, not semesterNumber — so the preview
// surfaces a warning count for the admin to review those separately.

const moveSemesterPlanSchema = z.object({
  classId: z.string().min(1),
  sourceSemesterNumber: z.number().int().min(1).max(8),
  targetSemesterNumber: z.number().int().min(1).max(8),
});

export type MoveSemesterPlanInput = z.infer<typeof moveSemesterPlanSchema>;

export interface MoveSemesterPlanPreview {
  /** Courses currently planned at the source level — what would move. */
  sourceCourses: { id: string; name: string }[];
  /** How many courses are already planned at the target level. */
  targetCourseCount: number;
  /** Source courses already present at the target level — skipped on move. */
  duplicateCourseNames: string[];
  /** Source courses that would actually be re-pointed (source − duplicates). */
  movingCount: number;
  /**
   * Existing LecturerCourseAssignments for THIS class referencing any of the
   * moved courses — moving the plan won't update these automatically.
   */
  assignmentCount: number;
  /** Timetable sessions hanging off those assignments. */
  timetableSlotCount: number;
}

export async function previewMoveSemesterPlan(
  input: MoveSemesterPlanInput
): Promise<MoveSemesterPlanPreview> {
  await requirePermission("curriculum.manage");
  const { classId, sourceSemesterNumber, targetSemesterNumber } =
    moveSemesterPlanSchema.parse(input);

  if (sourceSemesterNumber === targetSemesterNumber) {
    throw new Error("SAME_SEMESTER");
  }

  const [sourcePlans, targetPlans] = await Promise.all([
    prisma.classCoursePlan.findMany({
      where: { classId, semesterNumber: sourceSemesterNumber },
      include: { course: true },
      orderBy: { course: { name: "asc" } },
    }),
    prisma.classCoursePlan.findMany({
      where: { classId, semesterNumber: targetSemesterNumber },
      select: { courseId: true },
    }),
  ]);

  const targetCourseIds = new Set(targetPlans.map((p) => p.courseId));
  const movedCourseIds = sourcePlans.map((p) => p.courseId);
  const duplicateCourseNames = sourcePlans
    .filter((p) => targetCourseIds.has(p.courseId))
    .map((p) => p.course.name);

  const [assignmentCount, timetableSlotCount] =
    movedCourseIds.length === 0
      ? [0, 0]
      : await Promise.all([
          prisma.lecturerCourseAssignment.count({
            where: { classId, courseId: { in: movedCourseIds } },
          }),
          prisma.timetableSlot.count({
            where: { assignment: { classId, courseId: { in: movedCourseIds } } },
          }),
        ]);

  return {
    sourceCourses: sourcePlans.map((p) => ({
      id: p.course.id,
      name: p.course.name,
    })),
    targetCourseCount: targetPlans.length,
    duplicateCourseNames,
    movingCount: sourcePlans.length - duplicateCourseNames.length,
    assignmentCount,
    timetableSlotCount,
  };
}

export async function moveSemesterPlan(
  input: MoveSemesterPlanInput
): Promise<{ moved: number; skippedDuplicates: number }> {
  const admin = await requirePermission("curriculum.manage");
  const { classId, sourceSemesterNumber, targetSemesterNumber } =
    moveSemesterPlanSchema.parse(input);

  if (sourceSemesterNumber === targetSemesterNumber) {
    throw new Error("SAME_SEMESTER");
  }

  const [sourcePlans, targetPlans] = await Promise.all([
    prisma.classCoursePlan.findMany({
      where: { classId, semesterNumber: sourceSemesterNumber },
      include: { course: true },
    }),
    prisma.classCoursePlan.findMany({
      where: { classId, semesterNumber: targetSemesterNumber },
      select: { courseId: true },
    }),
  ]);

  if (sourcePlans.length === 0) {
    throw new Error("NO_COURSES_AT_SOURCE");
  }

  const targetCourseIds = new Set(targetPlans.map((p) => p.courseId));
  const duplicates = sourcePlans.filter((p) => targetCourseIds.has(p.courseId));
  const moving = sourcePlans.filter((p) => !targetCourseIds.has(p.courseId));
  const duplicateIds = duplicates.map((p) => p.id);
  const movingIds = moving.map((p) => p.id);

  // Two bounded statements (deleteMany + updateMany), regardless of how many
  // courses are in the plan — no per-row loop, so BULK_TRANSACTION_OPTIONS
  // isn't needed here (same reasoning as every other bounded transaction in
  // this app). sourcePlans.length > 0 guarantees at least one is non-empty.
  await prisma.$transaction([
    ...(duplicateIds.length > 0
      ? [
          prisma.classCoursePlan.deleteMany({
            where: { id: { in: duplicateIds } },
          }),
        ]
      : []),
    ...(movingIds.length > 0
      ? [
          prisma.classCoursePlan.updateMany({
            where: { id: { in: movingIds } },
            data: { semesterNumber: targetSemesterNumber },
          }),
        ]
      : []),
  ]);

  await audit({
    userId: admin.id,
    action: "COURSE_PLAN_SEMESTER_MOVED",
    entity: "Class",
    entityId: classId,
    oldValue: {
      semesterNumber: sourceSemesterNumber,
      courseCount: sourcePlans.length,
    },
    newValue: {
      semesterNumber: targetSemesterNumber,
      movedCourseCount: movingIds.length,
      skippedDuplicateCount: duplicateIds.length,
      movedCourses: moving.map((p) => p.course.name),
    },
  });

  revalidatePath("/admin/curriculum");
  return { moved: movingIds.length, skippedDuplicates: duplicateIds.length };
}
