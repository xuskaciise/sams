"use server";

import { revalidatePath } from "next/cache";
import { prisma, BULK_TRANSACTION_OPTIONS } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { autoEnrollStudentIntoClassCourses, auditAutoEnrollments } from "@/lib/enrollment";
import { buildStudentTransferPlan, type StudentTransferPlan } from "./plan";
import {
  studentTransferPreviewSchema,
  studentTransferSchema,
  type StudentTransferInput,
  type StudentTransferPreviewInput,
} from "./schema";

export async function previewStudentClassTransfer(
  input: StudentTransferPreviewInput
): Promise<StudentTransferPlan> {
  const user = await requirePermission("students.transfer");
  const data = studentTransferPreviewSchema.parse(input);
  return buildStudentTransferPlan(user.id, data.studentId, data.targetClassId);
}

export interface StudentTransferResult {
  transferredCount: number;
  createdCount: number;
  linkedCount: number;
  groupsLeft: number;
}

// Single-student, mid-semester class transfer. All-or-nothing: one
// interactive transaction; any failure (including a stale plan) rolls
// back every write, Student.classId included.
//
// Marks are NEVER moved: the old ACTIVE enrollments become TRANSFERRED
// (kept, never deleted) and keep every AssessmentResult under the old
// assignment/owner. For a course the target class also teaches, the old
// enrollment's transferredToId points at the new one — that chain is what
// lib/carry-over.ts walks to show those marks read-only to the new
// lecturer and to the student.
export async function transferStudentClass(
  input: StudentTransferInput
): Promise<StudentTransferResult> {
  const user = await requirePermission("students.transfer");
  const data = studentTransferSchema.parse(input);

  const plan = await buildStudentTransferPlan(user.id, data.studentId, data.targetClassId);

  if (plan.enrollmentsAffected && plan.targetHasNoCourses && !data.acknowledgeNoCourses) {
    throw new Error(
      `${plan.toClass.label} has no course assignments in the active semester — no courses would be enrolled. Confirm to transfer anyway.`
    );
  }

  const transferIds = plan.toTransfer.map((t) => t.enrollmentId);
  const semesterId = plan.activeSemester?.id ?? null;

  const outcome = await prisma.$transaction(async (tx) => {
    let linkedCount = 0;
    let groupsLeft = 0;

    if (plan.enrollmentsAffected && transferIds.length > 0) {
      // Demote BEFORE creating the new ACTIVE rows — the (student, course,
      // semester, status) unique index rejects two ACTIVE rows at once.
      const demoted = await tx.studentCourseEnrollment.updateMany({
        where: { id: { in: transferIds }, status: "ACTIVE" },
        data: { status: "TRANSFERRED" },
      });
      if (demoted.count !== transferIds.length) {
        // Something changed between planning and writing — abort the
        // whole transfer rather than half-apply it.
        throw new Error(
          "The student's enrollments changed while preparing this transfer — nothing was changed. Review the preview and try again."
        );
      }
    }

    await tx.student.update({
      where: { id: plan.student.id },
      data: { classId: plan.toClass.id },
    });

    // Reuse the one shared auto-enroll helper (active semester only,
    // skips anything already ACTIVE). Skipped entirely when the active
    // semester is closed — closed-semester data is never touched.
    const created = plan.enrollmentsAffected
      ? await autoEnrollStudentIntoClassCourses(tx, plan.student.id, plan.toClass.id)
      : [];

    if (plan.enrollmentsAffected) {
      const newByCourse = new Map(
        created
          .filter((c) => c.semesterId === semesterId)
          .map((c) => [c.courseId, c.enrollmentId])
      );
      for (const line of plan.toTransfer) {
        const newId = newByCourse.get(line.courseId);
        if (!newId) continue;
        await tx.studentCourseEnrollment.update({
          where: { id: line.enrollmentId },
          data: { transferredToId: newId },
        });
        linkedCount++;
      }

      // Leave the old class's course-level groups. Existing results keep
      // their groupId reference untouched (snapshot model).
      if (plan.groupsToLeave.length > 0) {
        const removed = await tx.groupMember.deleteMany({
          where: {
            studentId: plan.student.id,
            groupId: { in: plan.groupsToLeave.map((g) => g.groupId) },
          },
        });
        groupsLeft = removed.count;
      }
    }

    return { created, linkedCount, groupsLeft };
  }, BULK_TRANSACTION_OPTIONS);

  await audit({
    userId: user.id,
    action: "STUDENT_CLASS_TRANSFERRED",
    entity: "Student",
    entityId: plan.student.id,
    oldValue: { classId: plan.fromClass.id, className: plan.fromClass.label },
    newValue: {
      classId: plan.toClass.id,
      className: plan.toClass.label,
      studentNo: plan.student.studentNo,
      semesterId,
      enrollmentsTransferred: plan.enrollmentsAffected ? transferIds.length : 0,
      enrollmentsCreated: outcome.created.length,
      enrollmentsLinked: outcome.linkedCount,
      groupsLeft: outcome.groupsLeft,
      transferredCourses: plan.toTransfer.map((t) => t.courseName),
      createdCourses: plan.toCreate.map((c) => c.courseName),
    },
  });
  await auditAutoEnrollments(user.id, outcome.created);

  revalidatePath("/admin/students");
  revalidatePath("/admin/student-transfer");
  revalidatePath("/dean/student-transfer");

  return {
    transferredCount: plan.enrollmentsAffected ? transferIds.length : 0,
    createdCount: outcome.created.length,
    linkedCount: outcome.linkedCount,
    groupsLeft: outcome.groupsLeft,
  };
}
