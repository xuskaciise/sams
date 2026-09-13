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

// Close/Reopen — deliberately REVERSIBLE (Reopen exists), same
// never-hard-delete convention as every other simple-CRUD status toggle
// in this app (Room/Campus/Shift deactivate/reactivate, Student
// isActive) — an office mistake (closing the wrong period) shouldn't
// need a support ticket to fix. Does NOT touch any already-recorded
// MissedExamRecord — those stay fully visible/editable via
// exam.records.manage/.delete regardless of the period's status; closing
// only blocks NEW registrations. Enforced in TWO places: Form 2's period
// picker only ever offers OPEN periods (getActiveExamPeriodOptions), AND
// recordMissedExamsBulk re-checks status server-side before writing —
// this is a real security/workflow boundary (a stale page could still
// submit against a since-closed period), not just a picker convenience,
// so it's enforced on the server regardless of what the UI shows.
// ADMIN-only (exam.periods.manage) — DEAN never changes period status,
// same as it never creates one.
export async function setSpecialExamPeriodStatus(
  id: string,
  status: "OPEN" | "CLOSED"
) {
  const user = await requirePermission("exam.periods.manage");

  const period = await prisma.specialExamPeriod.findUnique({ where: { id } });
  if (!period) {
    throw new Error("NOT_FOUND");
  }

  await prisma.specialExamPeriod.update({ where: { id }, data: { status } });

  await audit({
    userId: user.id,
    action: status === "CLOSED" ? "SPECIAL_EXAM_PERIOD_CLOSED" : "SPECIAL_EXAM_PERIOD_REOPENED",
    entity: "SpecialExamPeriod",
    entityId: id,
    oldValue: { status: period.status },
    newValue: { status },
  });

  revalidateAll();
}
