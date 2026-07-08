"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireAssessmentOwner } from "@/lib/auth";
import { audit } from "@/lib/audit";
import {
  resultSchema,
  type ResultInput,
  correctionSchema,
  type CorrectionInput,
} from "./schema";

export async function saveResult(assessmentId: string, input: ResultInput) {
  const { user, assessment } = await requireAssessmentOwner(assessmentId);
  if (assessment.status !== "DRAFT") {
    throw new Error("NOT_EDITABLE");
  }

  const data = resultSchema.parse(input);
  const mark = data.attendanceStatus === "PRESENT" ? data.mark : null;

  if (mark !== null) {
    const max = Number(assessment.maximumMarks);
    if (mark < 0 || mark > max) {
      throw new Error("MARK_OUT_OF_RANGE");
    }
  }

  const existing = await prisma.assessmentResult.findUnique({
    where: {
      assessmentId_enrollmentId: {
        assessmentId,
        enrollmentId: data.enrollmentId,
      },
    },
  });

  if (existing) {
    const expected = data.currentUpdatedAt
      ? new Date(data.currentUpdatedAt)
      : null;
    if (!expected || expected.getTime() !== existing.updatedAt.getTime()) {
      throw new Error("STALE_WRITE");
    }

    const result = await prisma.assessmentResult.updateMany({
      where: { id: existing.id, updatedAt: existing.updatedAt },
      data: {
        mark,
        attendanceStatus: data.attendanceStatus,
        enteredBy: user.id,
        groupId: data.groupId ?? null,
      },
    });
    if (result.count === 0) {
      throw new Error("STALE_WRITE");
    }
  } else {
    await prisma.assessmentResult.create({
      data: {
        assessmentId,
        enrollmentId: data.enrollmentId,
        mark,
        attendanceStatus: data.attendanceStatus,
        enteredBy: user.id,
        groupId: data.groupId ?? null,
      },
    });
  }

  const fresh = await prisma.assessmentResult.findUniqueOrThrow({
    where: {
      assessmentId_enrollmentId: {
        assessmentId,
        enrollmentId: data.enrollmentId,
      },
    },
  });

  return { resultId: fresh.id, updatedAt: fresh.updatedAt.toISOString() };
}

export async function publishAssessment(assessmentId: string) {
  const { user, assessment } = await requireAssessmentOwner(assessmentId);
  if (assessment.status !== "DRAFT") {
    throw new Error("NOT_DRAFT");
  }

  await prisma.$transaction([
    prisma.assessment.update({
      where: { id: assessmentId },
      data: { status: "PUBLISHED" },
    }),
    prisma.assessmentResult.updateMany({
      where: { assessmentId },
      data: {
        status: "PUBLISHED",
        publishedBy: user.id,
        publishedAt: new Date(),
      },
    }),
  ]);

  await audit({
    userId: user.id,
    action: "RESULTS_PUBLISHED",
    entity: "Assessment",
    entityId: assessmentId,
  });

  revalidatePath(`/lecturer/assessments/${assessmentId}`);
}

export async function correctResult(
  assessmentId: string,
  resultId: string,
  input: CorrectionInput
) {
  const { user, assessment } = await requireAssessmentOwner(assessmentId);
  if (assessment.status !== "PUBLISHED") {
    throw new Error("NOT_PUBLISHED");
  }

  const data = correctionSchema.parse(input);
  const max = Number(assessment.maximumMarks);
  if (data.newMark < 0 || data.newMark > max) {
    throw new Error("MARK_OUT_OF_RANGE");
  }

  const result = await prisma.assessmentResult.findUniqueOrThrow({
    where: { id: resultId },
  });
  if (result.assessmentId !== assessmentId) {
    throw new Error("NOT_FOUND");
  }

  await prisma.$transaction([
    prisma.assessmentResult.update({
      where: { id: resultId },
      data: {
        mark: data.newMark,
        attendanceStatus: "PRESENT",
        isCorrected: true,
      },
    }),
    prisma.resultCorrection.create({
      data: {
        resultId,
        oldMark: result.mark,
        newMark: data.newMark,
        reason: data.reason,
        correctedBy: user.id,
      },
    }),
  ]);

  await audit({
    userId: user.id,
    action: "RESULT_CORRECTED",
    entity: "AssessmentResult",
    entityId: resultId,
    oldValue: { mark: result.mark ? Number(result.mark) : null },
    newValue: { mark: data.newMark, reason: data.reason },
  });

  revalidatePath(`/lecturer/assessments/${assessmentId}`);
}
