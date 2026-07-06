"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireAssessmentOwner } from "@/lib/auth";
import { getActiveEnrollments } from "./queries";
import { applyGroupMarkSchema, type ApplyGroupMarkInput } from "./schema";

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

  const targetEnrollments = members
    .map((member) => enrollmentByStudentId.get(member.studentId))
    .filter((enrollment): enrollment is NonNullable<typeof enrollment> =>
      Boolean(enrollment)
    );

  await prisma.$transaction(
    targetEnrollments.map((enrollment) =>
      prisma.assessmentResult.upsert({
        where: {
          assessmentId_enrollmentId: {
            assessmentId,
            enrollmentId: enrollment.id,
          },
        },
        update: {
          mark: data.mark,
          attendanceStatus: "PRESENT",
          groupId,
          enteredBy: user.id,
        },
        create: {
          assessmentId,
          enrollmentId: enrollment.id,
          mark: data.mark,
          attendanceStatus: "PRESENT",
          groupId,
          enteredBy: user.id,
        },
      })
    )
  );

  revalidatePath(`/lecturer/assessments/${assessmentId}`);
}
