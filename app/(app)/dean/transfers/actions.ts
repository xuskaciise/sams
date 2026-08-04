"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { audit } from "@/lib/audit";
import {
  getDeanDepartmentIds,
  assignmentDeanWhere,
  lecturerDeanWhere,
} from "@/lib/dean-scope";
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
  const departmentIds = await getDeanDepartmentIds(dean.id);

  // The scope check IS the query: an assignment (or lecturer) outside this
  // dean's overseen departments simply doesn't come back — never trust an
  // id from a URL/action param alone, same idiom as requireAssignmentOwner.
  const assignment = await prisma.lecturerCourseAssignment.findFirst({
    where: { id: assignmentId, ...assignmentDeanWhere(departmentIds) },
    include: { lecturer: true, semester: true },
  });
  if (!assignment) {
    throw new Error("NOT_FOUND");
  }
  if (assignment.semester.isClosed) {
    throw new Error("CLOSED_SEMESTER");
  }
  if (assignment.lecturerId === data.newLecturerId) {
    throw new Error("SAME_LECTURER");
  }

  // The new lecturer must also be within this dean's visible pool — the
  // lecturers currently teaching at least one assignment in one of their
  // departments (see lecturerDeanWhere) — not any lecturer university-wide.
  const newLecturer = await prisma.lecturer.findFirst({
    where: { id: data.newLecturerId, ...lecturerDeanWhere(departmentIds) },
  });
  if (!newLecturer) {
    throw new Error("LECTURER_NOT_FOUND");
  }
  // The target must already have a login account — they need to pick up
  // editing/publishing/correcting immediately, which an accountless
  // lecturer (see Lecturer Registration) can't do.
  if (!newLecturer.userId) {
    throw new Error("LECTURER_NO_ACCOUNT");
  }

  const assessments = await prisma.assessment.findMany({
    where: { assignmentId, deletedAt: null },
    select: { id: true },
  });

  // An accountless lecturer can never have created an assessment (creating
  // one requires being logged in), so if there's anything to transfer, the
  // current lecturer necessarily has a userId — this check is defensive,
  // not expected to ever fire.
  if (assessments.length > 0 && !assignment.lecturer.userId) {
    throw new Error("FROM_LECTURER_NO_ACCOUNT");
  }
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
          // Non-null by the invariant checked above (this map only runs
          // when assessments.length > 0).
          fromLecturer: fromLecturerUserId!,
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
    oldValue: { lecturerId: assignment.lecturerId, lecturerName: assignment.lecturer.fullName },
    newValue: {
      lecturerId: data.newLecturerId,
      lecturerName: newLecturer.fullName,
      reason: data.reason,
      assessmentsAffected: assessments.length,
    },
  });

  revalidatePath("/dean/transfers");
}
