"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission, requireAssessmentOwner } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { notifyResultsPublished } from "@/lib/whatsapp-notify";
import { emailResultsPublished } from "@/lib/email-notify";
import {
  resultSchema,
  type ResultInput,
  lateResultSchema,
  type LateResultInput,
  correctionSchema,
  type CorrectionInput,
} from "./schema";

export async function saveResult(assessmentId: string, input: ResultInput) {
  await requirePermission("results.enter");
  const { user, assessment } = await requireAssessmentOwner(assessmentId);

  const data = resultSchema.parse(input);

  const existing = await prisma.assessmentResult.findUnique({
    where: {
      assessmentId_enrollmentId: {
        assessmentId,
        enrollmentId: data.enrollmentId,
      },
    },
  });

  if (assessment.status === "CLOSED") {
    throw new Error("NOT_EDITABLE");
  }
  if (assessment.status === "PUBLISHED") {
    // The only thing still editable here once an assessment is PUBLISHED is
    // a late-added result that hasn't been published yet — everything else
    // (no result row at all, or an already-published one) must go through
    // addLateResult / correctResult respectively.
    if (!existing || existing.status !== "DRAFT") {
      throw new Error("NOT_EDITABLE");
    }
  }

  const mark = data.attendanceStatus === "PRESENT" ? data.mark : null;

  if (mark !== null) {
    const max = Number(assessment.maximumMarks);
    if (mark < 0 || mark > max) {
      throw new Error("MARK_OUT_OF_RANGE");
    }
  }

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

// Late-add: creates a NEW DRAFT result row for a student who is actively
// enrolled in this assessment's course/class/semester but has no result row
// yet — a late enrollment, a class transfer, or a repeater added after the
// original publish. Distinct from both saveResult (which only ever edits an
// EXISTING draft) and correctResult (which changes an EXISTING published
// mark with a mandatory reason): this is for a student who currently has NO
// result at all. Goes through the normal draft flow — entered here as
// DRAFT, then must be explicitly published via publishLateResult below —
// never bypasses draft-then-publish, and never touches any other student's
// already-published result.
export async function addLateResult(assessmentId: string, input: LateResultInput) {
  await requirePermission("results.enter");
  const { user, assessment } = await requireAssessmentOwner(assessmentId);
  if (assessment.status !== "PUBLISHED") {
    throw new Error("NOT_PUBLISHED");
  }

  const data = lateResultSchema.parse(input);
  const mark = data.attendanceStatus === "PRESENT" ? data.mark : null;

  if (mark !== null) {
    const max = Number(assessment.maximumMarks);
    if (mark < 0 || mark > max) {
      throw new Error("MARK_OUT_OF_RANGE");
    }
  }

  const assignment = await prisma.lecturerCourseAssignment.findUniqueOrThrow({
    where: { id: assessment.assignmentId },
  });

  const enrollment = await prisma.studentCourseEnrollment.findUnique({
    where: { id: data.enrollmentId },
  });
  if (
    !enrollment ||
    enrollment.courseId !== assignment.courseId ||
    enrollment.classId !== assignment.classId ||
    enrollment.semesterId !== assignment.semesterId ||
    enrollment.status !== "ACTIVE"
  ) {
    throw new Error("ENROLLMENT_NOT_FOUND");
  }

  // Never a way to late-add over a student who already has a result row —
  // that student goes through correctResult instead. The unique constraint
  // on (assessmentId, enrollmentId) would also catch this, but checking
  // first gives a specific, distinguishable error rather than a raw
  // constraint violation.
  const existing = await prisma.assessmentResult.findUnique({
    where: {
      assessmentId_enrollmentId: { assessmentId, enrollmentId: data.enrollmentId },
    },
  });
  if (existing) {
    throw new Error("ALREADY_HAS_RESULT");
  }

  const created = await prisma.assessmentResult.create({
    data: {
      assessmentId,
      enrollmentId: data.enrollmentId,
      mark,
      attendanceStatus: data.attendanceStatus,
      status: "DRAFT",
      enteredBy: user.id,
      groupId: data.groupId ?? null,
    },
  });

  await audit({
    userId: user.id,
    action: "LATE_RESULT_ADDED",
    entity: "AssessmentResult",
    entityId: created.id,
    newValue: {
      assessmentId,
      studentId: enrollment.studentId,
      enrollmentId: data.enrollmentId,
      mark,
      attendanceStatus: data.attendanceStatus,
    },
  });

  revalidatePath(`/lecturer/assessments/${assessmentId}`);

  return { resultId: created.id, updatedAt: created.updatedAt.toISOString() };
}

// Publishes exactly ONE late-added draft result — the "must be explicitly
// published separately" half of the late-add flow. Reuses the same
// assessment.publish permission and the same DRAFT -> PUBLISHED transition
// publishAssessment applies in bulk, just scoped to a single result row so
// it can run while the assessment itself is already PUBLISHED (and so it
// never re-touches every other student's already-published mark).
export async function publishLateResult(assessmentId: string, resultId: string) {
  await requirePermission("assessment.publish");
  const { user, assessment } = await requireAssessmentOwner(assessmentId);
  if (assessment.status !== "PUBLISHED") {
    throw new Error("NOT_PUBLISHED");
  }

  const result = await prisma.assessmentResult.findUniqueOrThrow({
    where: { id: resultId },
  });
  if (result.assessmentId !== assessmentId) {
    throw new Error("NOT_FOUND");
  }
  if (result.status !== "DRAFT") {
    throw new Error("ALREADY_PUBLISHED");
  }

  await prisma.assessmentResult.update({
    where: { id: resultId },
    data: {
      status: "PUBLISHED",
      publishedBy: user.id,
      publishedAt: new Date(),
    },
  });

  await audit({
    userId: user.id,
    action: "LATE_RESULT_PUBLISHED",
    entity: "AssessmentResult",
    entityId: resultId,
    newValue: { assessmentId, mark: result.mark ? Number(result.mark) : null },
  });

  revalidatePath(`/lecturer/assessments/${assessmentId}`);
}

export async function publishAssessment(assessmentId: string) {
  await requirePermission("assessment.publish");
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

  // Best-effort notifications — both fire-and-forget, never throw, so
  // publishing always succeeds regardless of whether WhatsApp / email is
  // enabled or working. WhatsApp: enqueue for the worker. Email: a real
  // send (Resend) to every affected student who has a real email on file,
  // WITHOUT the mark (see lib/email-notify.ts).
  await notifyResultsPublished(assessmentId);
  await emailResultsPublished(assessmentId);

  revalidatePath(`/lecturer/assessments/${assessmentId}`);
}

export async function correctResult(
  assessmentId: string,
  resultId: string,
  input: CorrectionInput
) {
  await requirePermission("results.correct");
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
