"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission, requireAssessmentOwner } from "@/lib/auth";
import { assessmentSchema, type AssessmentInput } from "./schema";

export async function createAssessment(
  assignmentId: string,
  input: AssessmentInput
) {
  const user = await requirePermission("assessment.create");
  const data = assessmentSchema.parse(input);

  const assignment = await prisma.lecturerCourseAssignment.findUniqueOrThrow({
    where: { id: assignmentId },
    include: { lecturer: true, semester: true },
  });
  if (assignment.lecturer.userId !== user.id) {
    throw new Error("FORBIDDEN");
  }
  if (assignment.semester.isClosed) {
    throw new Error("CLOSED_SEMESTER");
  }

  await prisma.assessment.create({
    data: {
      assignmentId,
      assessmentTypeId: data.assessmentTypeId,
      title: data.title,
      maximumMarks: data.maximumMarks,
      mode: data.mode,
      createdBy: user.id,
    },
  });

  revalidatePath(`/lecturer/assignments/${assignmentId}`);
}

export async function updateAssessment(
  assessmentId: string,
  input: AssessmentInput
) {
  await requirePermission("assessment.edit");
  const { assessment } = await requireAssessmentOwner(assessmentId);
  if (assessment.status !== "DRAFT") {
    throw new Error("NOT_EDITABLE");
  }
  const data = assessmentSchema.parse(input);

  await prisma.assessment.update({
    where: { id: assessmentId },
    data: {
      assessmentTypeId: data.assessmentTypeId,
      title: data.title,
      maximumMarks: data.maximumMarks,
      mode: data.mode,
    },
  });

  revalidatePath(`/lecturer/assignments/${assessment.assignmentId}`);
}

export async function deleteAssessment(assessmentId: string) {
  await requirePermission("assessment.edit");
  const { assessment } = await requireAssessmentOwner(assessmentId);
  if (assessment.status !== "DRAFT") {
    throw new Error("NOT_EDITABLE");
  }

  await prisma.assessment.update({
    where: { id: assessmentId },
    data: { deletedAt: new Date() },
  });

  revalidatePath(`/lecturer/assignments/${assessment.assignmentId}`);
}
