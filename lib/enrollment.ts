import { Prisma } from "@prisma/client";
import { audit } from "@/lib/audit";

type TxClient = Prisma.TransactionClient;

export interface AutoEnrolledRecord {
  enrollmentId: string;
  studentId: string;
  courseId: string;
  semesterId: string;
}

// Point 1 of auto-enrollment: a student is registered into (or moved into)
// a class — enroll them in every course assigned to that class for any
// currently-active semester. Skips courses they're already enrolled in.
//
// Duplicates are filtered out BEFORE issuing any create — catching a
// unique-constraint violation mid-transaction doesn't let Postgres carry on:
// once one statement in a transaction fails, every later statement in that
// same transaction fails too ("current transaction is aborted"), even if
// the JS catch block swallows the error. Pre-checking avoids ever hitting
// that failure in the common case of re-running this over already-enrolled
// students.
export async function autoEnrollStudentIntoClassCourses(
  tx: TxClient,
  studentId: string,
  classId: string
): Promise<AutoEnrolledRecord[]> {
  const assignments = await tx.lecturerCourseAssignment.findMany({
    where: { classId, semester: { isActive: true } },
  });
  if (assignments.length === 0) return [];

  const existing = await tx.studentCourseEnrollment.findMany({
    where: {
      studentId,
      status: "ACTIVE",
      OR: assignments.map((a) => ({
        courseId: a.courseId,
        semesterId: a.semesterId,
      })),
    },
    select: { courseId: true, semesterId: true },
  });
  const existingKeys = new Set(
    existing.map((e) => `${e.courseId}:${e.semesterId}`)
  );

  const created: AutoEnrolledRecord[] = [];
  for (const assignment of assignments) {
    if (existingKeys.has(`${assignment.courseId}:${assignment.semesterId}`)) {
      continue; // already enrolled — not an error
    }
    const enrollment = await tx.studentCourseEnrollment.create({
      data: {
        studentId,
        courseId: assignment.courseId,
        classId,
        semesterId: assignment.semesterId,
      },
    });
    created.push({
      enrollmentId: enrollment.id,
      studentId,
      courseId: assignment.courseId,
      semesterId: assignment.semesterId,
    });
  }
  return created;
}

// Point 2 of auto-enrollment: a new LecturerCourseAssignment is created —
// enroll every current student of that class into that course, for that
// assignment's semester. Same pre-filter reasoning as above.
export async function autoEnrollClassIntoAssignment(
  tx: TxClient,
  assignment: { courseId: string; classId: string; semesterId: string }
): Promise<AutoEnrolledRecord[]> {
  const students = await tx.student.findMany({
    where: { classId: assignment.classId },
  });
  if (students.length === 0) return [];

  const existing = await tx.studentCourseEnrollment.findMany({
    where: {
      courseId: assignment.courseId,
      semesterId: assignment.semesterId,
      status: "ACTIVE",
      studentId: { in: students.map((s) => s.id) },
    },
    select: { studentId: true },
  });
  const existingStudentIds = new Set(existing.map((e) => e.studentId));

  const created: AutoEnrolledRecord[] = [];
  for (const student of students) {
    if (existingStudentIds.has(student.id)) {
      continue; // already enrolled — not an error
    }
    const enrollment = await tx.studentCourseEnrollment.create({
      data: {
        studentId: student.id,
        courseId: assignment.courseId,
        classId: assignment.classId,
        semesterId: assignment.semesterId,
      },
    });
    created.push({
      enrollmentId: enrollment.id,
      studentId: student.id,
      courseId: assignment.courseId,
      semesterId: assignment.semesterId,
    });
  }
  return created;
}

// Audit logging happens after the transaction commits — audit() writes
// through the singleton client, not the transaction, so logging inside the
// transaction could leave stray rows behind a rollback.
export async function auditAutoEnrollments(
  actorUserId: string,
  records: AutoEnrolledRecord[]
): Promise<void> {
  for (const record of records) {
    await audit({
      userId: actorUserId,
      action: "AUTO_ENROLLED",
      entity: "StudentCourseEnrollment",
      entityId: record.enrollmentId,
      newValue: {
        studentId: record.studentId,
        courseId: record.courseId,
        semesterId: record.semesterId,
      },
    });
  }
}
