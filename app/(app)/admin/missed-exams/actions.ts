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
  getStudentSemesterCourses,
  getRegisteredCourseIds,
  type MissedExamScope,
  type StudentLookupResult,
  type CourseOption,
} from "./queries";

function revalidateAll() {
  revalidatePath("/admin/missed-exams");
  revalidatePath("/dean/missed-exams");
  revalidatePath("/exam-office");
}

export interface StudentLookupData {
  student: StudentLookupResult;
  // The student's own courses for the period's semester, MINUS those
  // already registered for (student, period).
  courses: CourseOption[];
  // Already registered for this period (read-only display).
  registered: CourseOption[];
}

// Form 2's entry point: look a student up by student_no (dean-scoped; a
// student outside the caller's faculty resolves as null, never leaking
// existence) for the SELECTED period. The course list is the student's
// enrollments in the period's semester, excluding already-registered ones.
export async function lookupStudentForMissedExam(
  studentNo: string,
  periodId: string
): Promise<StudentLookupData | null> {
  const user = await requirePermission("exam.records.manage");
  const scope = await resolveMissedExamScope(user.id);

  const trimmed = studentNo.trim();
  if (!trimmed || !periodId) return null;

  const student = await findStudentByNo(trimmed, scope.isDean, scope.departmentIds);
  if (!student) return null;

  const period = await prisma.specialExamPeriod.findUnique({
    where: { id: periodId },
    select: { semesterId: true },
  });
  if (!period) return null;

  const [enrolled, registeredIds] = await Promise.all([
    getStudentSemesterCourses(student.id, period.semesterId),
    getRegisteredCourseIds(student.id, periodId),
  ]);
  return {
    student,
    courses: enrolled.filter((c) => !registeredIds.has(c.id)),
    registered: enrolled.filter((c) => registeredIds.has(c.id)),
  };
}

// The bulk-grid submit: creates one MissedExamRecord per checked row,
// each tied directly to a courseId. Re-verifies EVERYTHING server-side
// (student scope, the period's existence AND its OPEN status, and that
// every courseId is in the student's enrollments for the period's
// semester and not already registered) rather than trusting the
// client's own grid state; invalid rows are silently skipped (never
// force-created), and the client is told how many were skipped. The
// period-status check is a REAL server-side boundary, not just a UI
// convenience — a page left open since before the period was closed must
// not still be able to save. A single `createMany` — no interactive
// transaction needed, since every check here is a plain read done BEFORE
// the one write (same "restructure away from a loop toward one batched
// createMany + app-level pre-checks" pattern CLAUDE.md documents as the
// alternative to a P2002-in-a-loop transaction).
export async function recordMissedExamsBulk(input: MissedExamBulkInput) {
  const user = await requirePermission("exam.records.manage");
  const data = missedExamBulkSchema.parse(input);
  const scope = await resolveMissedExamScope(user.id);

  // Dean scoping validates the STUDENT's own faculty — courses
  // themselves are never faculty-scoped anywhere in this app (there's no
  // department relation on Course), so this is the only scope check
  // needed even though the course list itself isn't filtered.
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
  if (period.status !== "OPEN") {
    throw new Error("PERIOD_CLOSED");
  }

  // Never trust the client's own copy of the course picker — re-derive
  // from the DB: only courses the student is enrolled in (non-DROPPED)
  // for the period's semester and not already registered for
  // (student, period).
  const [enrolled, registeredIds] = await Promise.all([
    getStudentSemesterCourses(student.id, period.semesterId),
    getRegisteredCourseIds(student.id, period.id),
  ]);
  const validCourseIds = new Set(
    enrolled.filter((c) => !registeredIds.has(c.id)).map((c) => c.id)
  );

  const toCreate: {
    studentId: string;
    courseId: string;
    specialExamPeriodId: string;
    examType: "MIDTERM" | "FINAL";
    reasonType: "ILLNESS" | "CHEATING" | "EMERGENCY" | "OTHER";
    reasonNote: string | null;
    recordedById: string;
  }[] = [];
  let skipped = 0;

  for (const row of data.rows) {
    if (!validCourseIds.has(row.courseId)) {
      skipped++;
      continue;
    }
    // Same course twice in one payload: only the first counts.
    validCourseIds.delete(row.courseId);
    toCreate.push({
      studentId: student.id,
      courseId: row.courseId,
      specialExamPeriodId: period.id,
      // Fixed by the period's phase (never a client value, never BOTH).
      examType: period.phase,
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
      course: { select: { name: true, code: true } },
    },
  });
}

// exam.records.manage — the SAME key that gates recording a new record —
// covers editing an existing one too (per CLAUDE.md: "exam.records.manage
// now covers create + edit"). Only examType/reasonType/reasonNote are
// editable; student/course/period never change here (that would just be
// a different record), and examType is fixed by the period's phase.
// Audited old->new.
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
      reasonType: existing.reasonType,
      reasonNote: existing.reasonNote,
    },
    newValue: {
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
