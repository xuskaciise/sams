"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { specialExamPeriodSchema, type SpecialExamPeriodInput } from "./schema";

const PATHS = ["/admin/exam-periods", "/admin/missed-exams", "/dean/missed-exams", "/exam-office"];

function revalidateAll() {
  for (const path of PATHS) revalidatePath(path);
}

// Form 1 — a simple, infrequent setup action (once per academic
// year+semester). Name is always server-composed
// ("{academicYear.name} — {semester.name}"), never free-typed. The
// duplicate guard is pre-checked with a friendly message naming the
// exact year+semester, same "thrown-message-not-generic-code" pattern as
// createSemester's own (academicYearId, semesterNumber) conflict check —
// never relies on the raw unique-constraint violation.
export async function createSpecialExamPeriod(input: SpecialExamPeriodInput) {
  const user = await requirePermission("exam.periods.manage");
  const data = specialExamPeriodSchema.parse(input);

  const semester = await prisma.semester.findUnique({
    where: { id: data.semesterId },
    include: { academicYear: true },
  });
  if (!semester || semester.academicYearId !== data.academicYearId) {
    throw new Error("SEMESTER_NOT_FOUND");
  }

  const existing = await prisma.specialExamPeriod.findFirst({
    where: { academicYearId: data.academicYearId, semesterId: data.semesterId },
  });
  if (existing) {
    throw new Error(
      `A Special Exam Period already exists for ${semester.academicYear.name} — ${semester.name}.`
    );
  }

  const name = `${semester.academicYear.name} — ${semester.name}`;
  const period = await prisma.specialExamPeriod.create({
    data: {
      academicYearId: data.academicYearId,
      semesterId: data.semesterId,
      name,
      createdById: user.id,
    },
  });

  await audit({
    userId: user.id,
    action: "SPECIAL_EXAM_PERIOD_CREATED",
    entity: "SpecialExamPeriod",
    entityId: period.id,
    newValue: { name, academicYearId: data.academicYearId, semesterId: data.semesterId },
  });

  revalidateAll();
  return period;
}

// A plain deactivate/reactivate toggle — same never-hard-delete
// convention as every other simple-CRUD entity in this app (Room/
// Campus/Shift). Does NOT touch any already-recorded MissedExamRecord;
// it only affects whether the period is still offered for NEW
// registrations (enforced client-side in Form 2's picker, since a
// deactivated period isn't a security boundary, just a "this sitting is
// closed" signal).
export async function setSpecialExamPeriodActive(id: string, isActive: boolean) {
  const user = await requirePermission("exam.periods.manage");

  const period = await prisma.specialExamPeriod.findUnique({ where: { id } });
  if (!period) {
    throw new Error("NOT_FOUND");
  }

  await prisma.specialExamPeriod.update({ where: { id }, data: { isActive } });

  await audit({
    userId: user.id,
    action: isActive ? "SPECIAL_EXAM_PERIOD_REACTIVATED" : "SPECIAL_EXAM_PERIOD_DEACTIVATED",
    entity: "SpecialExamPeriod",
    entityId: id,
    oldValue: { isActive: period.isActive },
    newValue: { isActive },
  });

  revalidateAll();
}
