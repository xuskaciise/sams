"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { audit } from "@/lib/audit";
import {
  missedExamBulkSchema,
  type MissedExamBulkInput,
  missedExamUpdateSchema,
  type MissedExamUpdateInput,
} from "./schema";
import {
  resolveMissedExamScope,
  findStudentByNo,
  getStudentEnrollmentRows,
  type MissedExamScope,
  type MissedExamGridRow,
  type StudentLookupResult,
} from "./queries";

function revalidateAll() {
  revalidatePath("/admin/missed-exams");
  revalidatePath("/dean/missed-exams");
  revalidatePath("/exam-office");
}

export interface StudentLookupData {
  student: StudentLookupResult;
  rows: MissedExamGridRow[];
}

// Form 2's entry point: look a student up by student_no directly (no
// Class/Semester-Level picker) and return their FULL enrollment history
// — every course they've ever been enrolled in, across every semester
// level, grouped by level client-side. Dean-scoped: a student outside
// the caller's faculty resolves as null, never leaking whether they
// exist elsewhere.
export async function lookupStudentForMissedExam(
  studentNo: string
): Promise<StudentLookupData | null> {
  const user = await requirePermission("exam.records.manage");
  const scope = await resolveMissedExamScope(user.id);

  const trimmed = studentNo.trim();
  if (!trimmed) return null;

  const student = await findStudentByNo(trimmed, scope.isDean, scope.departmentIds);
  if (!student) return null;

  const rows = await getStudentEnrollmentRows(student.id, scope.isDean, scope.departmentIds);
  return { student, rows };
}

// The bulk-grid submit: creates one MissedExamRecord per checked row,
// each tied to a SPECIFIC enrollmentId (never a bare courseId) — this is
// what correctly attributes a repeated course to the exact attempt it
// was missed in. Re-verifies EVERYTHING server-side (student scope, the
// period, and the exact same enrollment set the grid was built from)
// rather than trusting the client's own grid state; invalid rows are
// silently skipped (never force-created), and the client is told how
// many were skipped. A single `createMany` — no interactive transaction
// needed, since every check here is a plain read done BEFORE the one
// write (same "restructure away from a loop toward one batched
// createMany + app-level pre-checks" pattern CLAUDE.md documents as the
// alternative to a P2002-in-a-loop transaction).
export async function recordMissedExamsBulk(input: MissedExamBulkInput) {
  const user = await requirePermission("exam.records.manage");
  const data = missedExamBulkSchema.parse(input);
  const scope = await resolveMissedExamScope(user.id);

  const student = await prisma.student.findFirst({
    where: { id: data.studentId, ...(scope.isDean ? scope.studentScope : {}) },
  });
  if (!student) {
    throw new Error("STUDENT_NOT_FOUND");
  }

  const period = await prisma.specialExamPeriod.findUnique({
    where: { id: data.specialExamPeriodId },
  });
  if (!period) {
    throw new Error("PERIOD_NOT_FOUND");
  }

  // The exact same resolution the grid itself was built from — a
  // submitted row is only ever valid if its enrollmentId appears in THIS
  // list, closing the gap a tampered/stale row would otherwise open.
  const validRows = await getStudentEnrollmentRows(
    student.id,
    scope.isDean,
    scope.departmentIds
  );
  const validById = new Map(validRows.map((r) => [r.enrollmentId, r]));

  const toCreate: {
    studentId: string;
    enrollmentId: string;
    specialExamPeriodId: string;
    examType: "MIDTERM" | "FINAL" | "BOTH";
    reasonType: "ILLNESS" | "CHEATING" | "EMERGENCY" | "OTHER";
    reasonNote: string | null;
    recordedById: string;
  }[] = [];
  let skipped = 0;

  for (const row of data.rows) {
    const match = validById.get(row.enrollmentId);
    if (!match) {
      skipped++;
      continue;
    }
    toCreate.push({
      studentId: student.id,
      enrollmentId: match.enrollmentId,
      specialExamPeriodId: period.id,
      examType: row.examType,
      reasonType: row.reasonType,
      reasonNote: row.reasonNote || null,
      recordedById: user.id,
    });
  }

  if (toCreate.length > 0) {
    await prisma.missedExamRecord.createMany({ data: toCreate });
  }

  await audit({
    userId: user.id,
    action: "MISSED_EXAM_BULK_RECORDED",
    entity: "Student",
    entityId: student.id,
    newValue: {
      specialExamPeriodName: period.name,
      studentNo: student.studentNo,
      studentName: student.fullName,
      createdCount: toCreate.length,
      skippedCount: skipped,
    },
  });

  revalidateAll();
  return { created: toCreate.length, skipped };
}

// Shared by both edit and delete below — the record's own scope check IS
// the query, same "ownership-check-IS-the-query" idiom as everywhere
// else in this app: a Dean's scope (missedExamRecordDeanWhere, via
// resolveMissedExamScope) is applied directly in the lookup, so a record
// outside their faculty simply returns NOT_FOUND, never a 403 that would
// leak its existence.
async function findScopedRecord(id: string, scope: MissedExamScope) {
  return prisma.missedExamRecord.findFirst({
    where: { id, ...(scope.recordScope ?? {}) },
    include: {
      student: { select: { studentNo: true, fullName: true } },
      enrollment: { include: { course: { select: { name: true, code: true } } } },
    },
  });
}

// exam.records.manage — the SAME key that gates recording a new record —
// covers editing an existing one too (per CLAUDE.md: "exam.records.manage
// now covers create + edit"). Only examType/reasonType/reasonNote are
// editable; student/enrollment/period never change here (that would
// just be a different record). Audited old->new.
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
      courseName: existing.enrollment.course.name,
      examType: existing.examType,
      reasonType: existing.reasonType,
    },
  });

  revalidateAll();
}
