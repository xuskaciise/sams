"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireAssessmentOwner } from "@/lib/auth";
import { getActiveEnrollments } from "./queries";
import {
  groupNameSchema,
  type GroupNameInput,
  applyGroupMarkSchema,
  type ApplyGroupMarkInput,
} from "./schema";

export async function createGroup(assessmentId: string, input: GroupNameInput) {
  const { assessment } = await requireAssessmentOwner(assessmentId);
  if (assessment.status !== "DRAFT") {
    throw new Error("NOT_EDITABLE");
  }
  const data = groupNameSchema.parse(input);

  await prisma.studentGroup.create({
    data: { assessmentId, name: data.name },
  });

  revalidatePath(`/lecturer/assessments/${assessmentId}`);
}

export async function deleteGroup(assessmentId: string, groupId: string) {
  const { assessment } = await requireAssessmentOwner(assessmentId);
  if (assessment.status !== "DRAFT") {
    throw new Error("NOT_EDITABLE");
  }

  await prisma.studentGroup.delete({ where: { id: groupId } });

  revalidatePath(`/lecturer/assessments/${assessmentId}`);
}

export async function addGroupMember(
  assessmentId: string,
  groupId: string,
  studentId: string
) {
  const { assessment } = await requireAssessmentOwner(assessmentId);
  if (assessment.status !== "DRAFT") {
    throw new Error("NOT_EDITABLE");
  }

  try {
    await prisma.groupMember.create({
      data: { assessmentId, groupId, studentId },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new Error("ALREADY_IN_GROUP");
    }
    throw error;
  }

  revalidatePath(`/lecturer/assessments/${assessmentId}`);
}

export async function removeGroupMember(assessmentId: string, memberId: string) {
  const { assessment } = await requireAssessmentOwner(assessmentId);
  if (assessment.status !== "DRAFT") {
    throw new Error("NOT_EDITABLE");
  }

  await prisma.groupMember.delete({ where: { id: memberId } });

  revalidatePath(`/lecturer/assessments/${assessmentId}`);
}

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
    where: { groupId, assessmentId },
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
