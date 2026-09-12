"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { assignmentDeanWhere } from "@/lib/dean-scope";
import { missedExamRecordSchema, type MissedExamRecordInput } from "./schema";
import { resolveMissedExamScope, getStudentExamOptions } from "./queries";

// Live lookup for the registration form: given a picked student, return
// the courses a missed exam can be recorded against (their own ACTIVE
// enrollments, resolved to a real LecturerCourseAssignment). Same
// permission gate as recording one; scope is re-derived from the
// caller's role, never trusted from the client.
export async function getStudentExamOptionsAction(studentId: string) {
  const user = await requirePermission("exam.records.manage");
  const scope = await resolveMissedExamScope(user.id);
  if (!studentId) return [];

  // A Dean may only look up options for a student within their own
  // faculty — same "student must resolve through the scope" guard as
  // recordMissedExam itself.
  if (scope.isDean) {
    const student = await prisma.student.findFirst({
      where: { id: studentId, ...scope.studentScope },
      select: { id: true },
    });
    if (!student) return [];
  }

  return getStudentExamOptions(studentId, scope.isDean, scope.departmentIds);
}

// exam.records.manage is held by both ADMIN and DEAN — the permission
// alone doesn't say which faculty they may register for. That's the
// ROLE's job (resolveMissedExamScope), same idiom as
// createDailyLogEntry: ADMIN can record for any student/course; DEAN
// only within their own dean_departments scope, re-verified here
// server-side regardless of what the client's picker already filtered.
export async function recordMissedExam(input: MissedExamRecordInput) {
  const user = await requirePermission("exam.records.manage");
  const data = missedExamRecordSchema.parse(input);
  const scope = await resolveMissedExamScope(user.id);

  const student = await prisma.student.findFirst({
    where: { id: data.studentId, ...(scope.isDean ? scope.studentScope : {}) },
  });
  if (!student) {
    throw new Error("STUDENT_NOT_FOUND");
  }

  const assignment = await prisma.lecturerCourseAssignment.findFirst({
    where: {
      id: data.assignmentId,
      ...(scope.isDean ? assignmentDeanWhere(scope.departmentIds) : {}),
    },
    include: { course: true },
  });
  if (!assignment) {
    throw new Error("ASSIGNMENT_NOT_FOUND");
  }

  // Defends against a tampered/stale assignmentId that doesn't actually
  // belong to THIS student's own enrollments — the picker only ever
  // offers options resolved from the student's real ACTIVE enrollments
  // (see getStudentExamOptions), so a mismatch here means the submitted
  // ids were never a genuine pair from that picker.
  const enrollment = await prisma.studentCourseEnrollment.findFirst({
    where: {
      studentId: student.id,
      courseId: assignment.courseId,
      classId: assignment.classId,
      semesterId: assignment.semesterId,
      status: "ACTIVE",
    },
  });
  if (!enrollment) {
    throw new Error("NOT_ENROLLED");
  }

  const record = await prisma.missedExamRecord.create({
    data: {
      studentId: student.id,
      courseId: assignment.courseId,
      assignmentId: assignment.id,
      semesterId: assignment.semesterId,
      examType: data.examType,
      reasonType: data.reasonType,
      reasonNote: data.reasonNote || null,
      recordedById: user.id,
    },
  });

  await audit({
    userId: user.id,
    action: "MISSED_EXAM_RECORDED",
    entity: "MissedExamRecord",
    entityId: record.id,
    newValue: {
      studentId: student.id,
      studentNo: student.studentNo,
      studentName: student.fullName,
      courseName: assignment.course.name,
      examType: record.examType,
      reasonType: record.reasonType,
    },
  });

  revalidatePath("/admin/missed-exams");
  revalidatePath("/dean/missed-exams");
}
