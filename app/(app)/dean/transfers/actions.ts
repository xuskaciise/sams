"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { transferOwnershipSchema, type TransferOwnershipInput } from "./schema";

// Transfers BOTH the assignment's lecturer (so the new lecturer can see it
// under "My Courses" and create new assessments) AND effective ownership
// of every existing assessment under it (so they can keep editing drafts,
// publishing, and correcting) — see requireAssessmentOwner in lib/auth.ts,
// which resolves "effective owner" as the most recent ownership_transfers
// row for an assessment, falling back to created_by. created_by itself is
// never changed — it's kept as permanent history of who first made it.
export async function transferOwnership(
  assignmentId: string,
  input: TransferOwnershipInput
) {
  const dean = await requirePermission("ownership.transfer");
  const data = transferOwnershipSchema.parse(input);

  const assignment = await prisma.lecturerCourseAssignment.findUniqueOrThrow({
    where: { id: assignmentId },
    include: { lecturer: { include: { user: true } }, semester: true },
  });
  if (assignment.semester.isClosed) {
    throw new Error("CLOSED_SEMESTER");
  }
  if (assignment.lecturerId === data.newLecturerId) {
    throw new Error("SAME_LECTURER");
  }

  const newLecturer = await prisma.lecturer.findUniqueOrThrow({
    where: { id: data.newLecturerId },
    include: { user: true },
  });

  const assessments = await prisma.assessment.findMany({
    where: { assignmentId, deletedAt: null },
    select: { id: true },
  });

  const fromLecturerUserId = assignment.lecturer.userId;
  const toLecturerUserId = newLecturer.userId;

  await prisma.$transaction([
    prisma.lecturerCourseAssignment.update({
      where: { id: assignmentId },
      data: { lecturerId: data.newLecturerId },
    }),
    ...assessments.map((assessment) =>
      prisma.ownershipTransfer.create({
        data: {
          assessmentId: assessment.id,
          fromLecturer: fromLecturerUserId,
          toLecturer: toLecturerUserId,
          transferredBy: dean.id,
          reason: data.reason,
        },
      })
    ),
  ]);

  await audit({
    userId: dean.id,
    action: "OWNERSHIP_TRANSFERRED",
    entity: "LecturerCourseAssignment",
    entityId: assignmentId,
    oldValue: { lecturerId: assignment.lecturerId, lecturerName: assignment.lecturer.user.fullName },
    newValue: {
      lecturerId: data.newLecturerId,
      lecturerName: newLecturer.user.fullName,
      reason: data.reason,
      assessmentsAffected: assessments.length,
    },
  });

  revalidatePath("/dean/transfers");
}
