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
export async function autoEnrollStudentIntoClassCourses(
  tx: TxClient,
  studentId: string,
  classId: string
): Promise<AutoEnrolledRecord[]> {
  const assignments = await tx.lecturerCourseAssignment.findMany({
    where: { classId, semester: { isActive: true } },
  });

  const created: AutoEnrolledRecord[] = [];
  for (const assignment of assignments) {
    try {
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
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        continue; // already enrolled — not an error
      }
      throw error;
    }
  }
  return created;
}

// Point 2 of auto-enrollment: a new LecturerCourseAssignment is created —
// enroll every current student of that class into that course, for that
// assignment's semester.
export async function autoEnrollClassIntoAssignment(
  tx: TxClient,
  assignment: { courseId: string; classId: string; semesterId: string }
): Promise<AutoEnrolledRecord[]> {
  const students = await tx.student.findMany({
    where: { classId: assignment.classId },
  });

  const created: AutoEnrolledRecord[] = [];
  for (const student of students) {
    try {
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
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        continue; // already enrolled — not an error
      }
      throw error;
    }
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
