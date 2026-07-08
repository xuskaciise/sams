"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { audit } from "@/lib/audit";
import {
  autoEnrollClassIntoAssignment,
  auditAutoEnrollments,
  type AutoEnrolledRecord,
} from "@/lib/enrollment";
import {
  assignmentSchema,
  type AssignmentInput,
  bulkAssignmentSchema,
  type BulkAssignmentInput,
  type BulkAssignmentRow,
} from "./schema";

// A course in a class in a semester has exactly one lecturer — checked here
// (not just relied on via the DB unique constraint) so a conflict can name
// the lecturer already teaching it, per the Dean-ownership-transfer message.
export async function createAssignment(input: AssignmentInput) {
  const admin = await requireRole("ADMIN");
  const data = assignmentSchema.parse(input);

  const existing = await prisma.lecturerCourseAssignment.findFirst({
    where: {
      courseId: data.courseId,
      classId: data.classId,
      semesterId: data.semesterId,
    },
    include: { lecturer: { include: { user: true } } },
  });
  if (existing) {
    throw new Error(
      `This course in this class already has a lecturer (${existing.lecturer.user.fullName}). Use Dean ownership transfer to replace them.`
    );
  }

  let autoEnrolled: AutoEnrolledRecord[];
  try {
    autoEnrolled = await prisma.$transaction(async (tx) => {
      const assignment = await tx.lecturerCourseAssignment.create({ data });
      return autoEnrollClassIntoAssignment(tx, assignment);
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new Error(
        "This course in this class already has a lecturer. Use Dean ownership transfer to replace them."
      );
    }
    throw error;
  }
  await auditAutoEnrollments(admin.id, autoEnrolled);

  revalidatePath("/admin/curriculum");
  revalidatePath("/admin/students");
}

export interface BulkAssignmentRowResult extends BulkAssignmentRow {
  status: "created" | "skipped";
  reason?: string;
}

export interface BulkAssignmentResult {
  created: number;
  skipped: number;
  results: BulkAssignmentRowResult[];
}

// Mid-semester / ad-hoc bulk assign — the Open Semester wizard remains the
// main tool for a normal semester open, this is for one-off exceptions
// (new course added mid-term, additional class picked up, etc). One
// transaction; rows that already exist or conflict with the
// one-lecturer-per-course+class+semester rule are skipped with a reason
// instead of failing the whole batch.
export async function bulkCreateAssignments(
  input: BulkAssignmentInput
): Promise<BulkAssignmentResult> {
  const admin = await requireRole("ADMIN");
  const data = bulkAssignmentSchema.parse(input);

  const semester = await prisma.semester.findUniqueOrThrow({
    where: { id: data.semesterId },
  });
  if (semester.isClosed) {
    throw new Error("CLOSED_SEMESTER");
  }

  // Pre-check what already exists BEFORE the transaction: Postgres aborts
  // the whole transaction on the first failed statement, so a row that
  // would violate the one-lecturer-per-course+class+semester constraint
  // must be filtered out up front, never caught mid-loop (see CLAUDE.md
  // conventions). A course+class repeated within the same submitted batch
  // is the same hazard, so it's tracked the same way.
  const existing = await prisma.lecturerCourseAssignment.findMany({
    where: {
      semesterId: data.semesterId,
      OR: data.rows.map((r) => ({ courseId: r.courseId, classId: r.classId })),
    },
    include: { lecturer: { include: { user: true } } },
  });
  const existingNameByKey = new Map(
    existing.map((a) => [`${a.courseId}:${a.classId}`, a.lecturer.user.fullName])
  );

  const seen = new Set<string>();
  const results: BulkAssignmentRowResult[] = [];
  const toCreate: BulkAssignmentRow[] = [];

  for (const row of data.rows) {
    const key = `${row.courseId}:${row.classId}`;
    const existingName = existingNameByKey.get(key);
    if (existingName) {
      results.push({ ...row, status: "skipped", reason: `Already assigned to ${existingName}` });
      continue;
    }
    if (seen.has(key)) {
      results.push({ ...row, status: "skipped", reason: "Duplicate row in this batch" });
      continue;
    }
    seen.add(key);
    toCreate.push(row);
    results.push({ ...row, status: "created" });
  }

  const autoEnrolled: AutoEnrolledRecord[] = [];
  if (toCreate.length > 0) {
    await prisma.$transaction(async (tx) => {
      for (const row of toCreate) {
        const assignment = await tx.lecturerCourseAssignment.create({
          data: { ...row, semesterId: data.semesterId },
        });
        const enrolled = await autoEnrollClassIntoAssignment(tx, assignment);
        autoEnrolled.push(...enrolled);
      }
    });
  }

  await audit({
    userId: admin.id,
    action: "BULK_ASSIGNED",
    entity: "LecturerCourseAssignment",
    newValue: {
      semesterId: data.semesterId,
      requested: data.rows.length,
      created: toCreate.length,
      skipped: data.rows.length - toCreate.length,
    },
  });
  await auditAutoEnrollments(admin.id, autoEnrolled);

  revalidatePath("/admin/curriculum");
  revalidatePath("/admin/students");

  return {
    created: toCreate.length,
    skipped: data.rows.length - toCreate.length,
    results,
  };
}

export async function deleteAssignment(id: string) {
  await requireRole("ADMIN");
  await prisma.lecturerCourseAssignment.delete({ where: { id } });
  revalidatePath("/admin/curriculum");
}
