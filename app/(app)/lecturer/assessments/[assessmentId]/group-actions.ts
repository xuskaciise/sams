"use server";

import { revalidatePath } from "next/cache";
import type { AttendanceStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireAssessmentOwner } from "@/lib/auth";
import { getActiveEnrollments } from "./queries";
import { applyGroupMarkSchema, type ApplyGroupMarkInput } from "./schema";

// Snapshot model: one mark, copied to every member's result row in a single
// transaction. Attendance stays per-member even here — a member marked
// ABSENT/EXEMPT gets a null mark regardless of the shared value, matching
// how attendance/mark interact everywhere else in the app.
export async function applySameMarkToGroup(
  assessmentId: string,
  groupId: string,
  input: ApplyGroupMarkInput
) {
  const { user, assessment } = await requireAssessmentOwner(assessmentId);
  if (assessment.status !== "DRAFT") {
    throw new Error("NOT_EDITABLE");
  }
  const data = applyGroupMarkSchema.parse(input);

  const max = Number(assessment.maximumMarks);
  if (data.mark < 0 || data.mark > max) {
    throw new Error("MARK_OUT_OF_RANGE");
  }

  const assignment = await prisma.lecturerCourseAssignment.findUniqueOrThrow({
    where: { id: assessment.assignmentId },
  });
  const enrollments = await getActiveEnrollments(assignment);
  const enrollmentByStudentId = new Map(
    enrollments.map((e) => [e.studentId, e])
  );

  const members = await prisma.groupMember.findMany({
    where: { groupId },
  });

  const targets = members
    .map((member) => ({
      enrollment: enrollmentByStudentId.get(member.studentId),
      attendanceStatus: data.attendanceByStudentId[member.studentId] ?? "PRESENT",
    }))
    .filter(
      (
        t
      ): t is {
        enrollment: NonNullable<typeof t.enrollment>;
        attendanceStatus: AttendanceStatus;
      } => Boolean(t.enrollment)
    );

  await prisma.$transaction(
    targets.map(({ enrollment, attendanceStatus }) => {
      const mark = attendanceStatus === "PRESENT" ? data.mark : null;
      return prisma.assessmentResult.upsert({
        where: {
          assessmentId_enrollmentId: {
            assessmentId,
            enrollmentId: enrollment.id,
          },
        },
        update: {
          mark,
          attendanceStatus,
          groupId,
          enteredBy: user.id,
        },
        create: {
          assessmentId,
          enrollmentId: enrollment.id,
          mark,
          attendanceStatus,
          groupId,
          enteredBy: user.id,
        },
      });
    })
  );

  revalidatePath(`/lecturer/assessments/${assessmentId}`);
}
