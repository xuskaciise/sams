"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { classDeanWhere } from "@/lib/dean-scope";
import {
  missedExamBulkSchema,
  type MissedExamBulkInput,
  missedExamUpdateSchema,
  type MissedExamUpdateInput,
} from "./schema";
import {
  resolveMissedExamScope,
  getClassesForLevel,
  getMissedExamGridRows,
  type ClassOption,
  type MissedExamGridRow,
  type MissedExamScope,
} from "./queries";

function revalidateAll() {
  revalidatePath("/admin/missed-exams");
  revalidatePath("/dean/missed-exams");
  revalidatePath("/exam-office");
}

// Live lookup for Form 2's Semester Level -> Class cascade — dean-scoped,
// same idiom as Workload Import's own class picker.
export async function getClassesForLevelAction(level: number): Promise<ClassOption[]> {
  const user = await requirePermission("exam.records.manage");
  const scope = await resolveMissedExamScope(user.id);
  return getClassesForLevel(level, scope.isDean, scope.departmentIds);
}

// Live lookup for the bulk grid itself, once a Period + Class are both
// picked. The class is re-verified in-scope here — never trusted from
// the client's own cascading picker.
export async function getMissedExamGridRowsAction(
  classId: string,
  specialExamPeriodId: string
): Promise<MissedExamGridRow[]> {
  const user = await requirePermission("exam.records.manage");
  const scope = await resolveMissedExamScope(user.id);

  const cls = await prisma.class.findFirst({
    where: {
      id: classId,
      deletedAt: null,
      ...(scope.isDean ? classDeanWhere(scope.departmentIds) : {}),
    },
    select: { id: true },
  });
  if (!cls) return [];

  const period = await prisma.specialExamPeriod.findUnique({
    where: { id: specialExamPeriodId },
    select: { semesterId: true },
  });
  if (!period) return [];

  return getMissedExamGridRows(classId, period.semesterId);
}

// The bulk-grid submit: creates one MissedExamRecord per checked row.
// Re-verifies EVERYTHING server-side (period, class scope, and — for
// each row — that the assignment genuinely belongs to this class+period
// AND the student genuinely has a matching ACTIVE enrollment) rather
// than trusting the client's own grid state; invalid rows are silently
// skipped (never force-created), and the client is told how many were
// skipped. A single `createMany` — no interactive transaction needed,
// since every check here is a plain read done BEFORE the one write (same
// "restructure away from a loop toward one batched createMany + app-
// level pre-checks" pattern CLAUDE.md documents as the alternative to a
// P2002-in-a-loop transaction).
export async function recordMissedExamsBulk(input: MissedExamBulkInput) {
  const user = await requirePermission("exam.records.manage");
  const data = missedExamBulkSchema.parse(input);
  const scope = await resolveMissedExamScope(user.id);

  const period = await prisma.specialExamPeriod.findUnique({
    where: { id: data.specialExamPeriodId },
  });
  if (!period) {
    throw new Error("PERIOD_NOT_FOUND");
  }

  const cls = await prisma.class.findFirst({
    where: {
      id: data.classId,
      deletedAt: null,
      ...(scope.isDean ? classDeanWhere(scope.departmentIds) : {}),
    },
    select: { id: true, name: true },
  });
  if (!cls) {
    throw new Error("CLASS_NOT_FOUND");
  }

  // The exact same resolution the grid itself was built from — a
  // submitted row is only ever valid if it appears in THIS list, closing
  // the gap a tampered/stale row would otherwise open.
  const validRows = await getMissedExamGridRows(data.classId, period.semesterId);
  const validByKey = new Map(
    validRows.map((r) => [`${r.studentId}:${r.assignmentId}`, r])
  );

  const toCreate: {
    studentId: string;
    courseId: string;
    assignmentId: string;
    specialExamPeriodId: string;
    examType: "MIDTERM" | "FINAL" | "BOTH";
    reasonType: "ILLNESS" | "CHEATING" | "EMERGENCY" | "OTHER";
    reasonNote: string | null;
    recordedById: string;
  }[] = [];
  let skipped = 0;
  const studentNames: string[] = [];

  for (const row of data.rows) {
    const match = validByKey.get(`${row.studentId}:${row.assignmentId}`);
    if (!match) {
      skipped++;
      continue;
    }
    toCreate.push({
      studentId: match.studentId,
      courseId: match.courseId,
      assignmentId: match.assignmentId,
      specialExamPeriodId: period.id,
      examType: row.examType,
      reasonType: row.reasonType,
      reasonNote: row.reasonNote || null,
      recordedById: user.id,
    });
    studentNames.push(match.studentFullName);
  }

  if (toCreate.length > 0) {
    await prisma.missedExamRecord.createMany({ data: toCreate });
  }

  await audit({
    userId: user.id,
    action: "MISSED_EXAM_BULK_RECORDED",
    entity: "SpecialExamPeriod",
    entityId: period.id,
    newValue: {
      specialExamPeriodName: period.name,
      className: cls.name,
      createdCount: toCreate.length,
      skippedCount: skipped,
      students: studentNames,
    },
  });

  revalidateAll();
  return { created: toCreate.length, skipped };
}

// Shared by both edit and delete below — the record's own scope check
// IS the query, same "ownership-check-IS-the-query" idiom as everywhere
// else in this app: a Dean's scope (missedExamRecordDeanWhere, via
// resolveMissedExamScope) is applied directly in the lookup, so a record
// outside their faculty simply returns NOT_FOUND, never a 403 that would
// leak its existence.
async function findScopedRecord(id: string, scope: MissedExamScope) {
  return prisma.missedExamRecord.findFirst({
    where: { id, ...(scope.recordScope ?? {}) },
    include: {
      student: { select: { studentNo: true, fullName: true } },
      course: { select: { name: true, code: true } },
    },
  });
}

// exam.records.manage — the SAME key that gates recording a new record —
// covers editing an existing one too (per CLAUDE.md: "exam.records.manage
// now covers create + edit"). Only examType/reasonType/reasonNote are
// editable; student/course/assignment/period never change here (that
// would just be a different record). Audited old->new.
export async function updateMissedExamRecord(id: string, input: MissedExamUpdateInput) {
  const user = await requirePermission("exam.records.manage");
  const data = missedExamUpdateSchema.parse(input);
  const scope = await resolveMissedExamScope(user.id);

  const existing = await findScopedRecord(id, scope);
  if (!existing) {
    throw new Error("NOT_FOUND");
  }

  const updated = await prisma.missedExamRecord.update({
    where: { id },
    data: {
      examType: data.examType,
      reasonType: data.reasonType,
      reasonNote: data.reasonNote || null,
    },
  });

  await audit({
    userId: user.id,
    action: "MISSED_EXAM_UPDATED",
    entity: "MissedExamRecord",
    entityId: id,
    oldValue: {
      examType: existing.examType,
      reasonType: existing.reasonType,
      reasonNote: existing.reasonNote,
    },
    newValue: {
      examType: updated.examType,
      reasonType: updated.reasonType,
      reasonNote: updated.reasonNote,
    },
  });

  revalidateAll();
  return updated;
}

// A SEPARATE permission from exam.records.manage — see the
// "exam.records.delete" bullet in CLAUDE.md. An admin can grant
// exam.records.manage (create + edit) to someone without also granting
// exam.records.delete, via the existing per-role/per-user permission
// system (a custom role, or a per-user DENY override on top of a role
// that holds both). A genuine hard delete (MissedExamRecord has no
// deletedAt column, same "narrow, deliberately hard-delete" precedent as
// deleteLecturer — this isn't the "assessments/results/enrollments/audit
// logs" category the soft-delete-only rule in CLAUDE.md is about).
export async function deleteMissedExamRecord(id: string) {
  const user = await requirePermission("exam.records.delete");
  const scope = await resolveMissedExamScope(user.id);

  const existing = await findScopedRecord(id, scope);
  if (!existing) {
    throw new Error("NOT_FOUND");
  }

  await prisma.missedExamRecord.delete({ where: { id } });

  await audit({
    userId: user.id,
    action: "MISSED_EXAM_DELETED",
    entity: "MissedExamRecord",
    entityId: id,
    oldValue: {
      studentNo: existing.student.studentNo,
      studentName: existing.student.fullName,
      courseName: existing.course.name,
      examType: existing.examType,
      reasonType: existing.reasonType,
    },
  });

  revalidateAll();
}
