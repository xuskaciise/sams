"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { transferStudentsSchema, type TransferStudentsInput } from "./schema";

// Exceptions-only tool (repeaters, section changes) — normal semester
// progression happens automatically via the Open Semester wizard advancing
// each batch's currentSemesterNumber, not by moving students between class
// rows. This only ever touches Student.classId. Existing enrollments keep
// their original classId/semesterId as the historical record — new
// enrollments for the target class come from "Open semester", not from
// this transfer itself.
export async function transferStudents(input: TransferStudentsInput) {
  const admin = await requirePermission("students.manage");
  const data = transferStudentsSchema.parse(input);

  const sourceClass = await prisma.class.findUniqueOrThrow({
    where: { id: data.sourceClassId },
  });

  if (data.target.mode === "existing" && data.target.classId === data.sourceClassId) {
    throw new Error("SAME_CLASS");
  }

  let targetClassId: string;
  let transferredCount: number;
  try {
    ({ targetClassId, transferredCount } = await prisma.$transaction(async (tx) => {
      const targetClassId =
        data.target.mode === "new"
          ? (
              await tx.class.create({
                data: { name: data.target.name, programId: sourceClass.programId },
              })
            ).id
          : data.target.classId;

      const result = await tx.student.updateMany({
        where: { id: { in: data.studentIds }, classId: data.sourceClassId },
        data: { classId: targetClassId },
      });

      return { targetClassId, transferredCount: result.count };
    }));
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new Error("DUPLICATE_CLASS_NAME");
    }
    throw error;
  }

  await audit({
    userId: admin.id,
    action: "STUDENTS_TRANSFERRED",
    entity: "Class",
    entityId: data.sourceClassId,
    newValue: {
      sourceClassId: data.sourceClassId,
      targetClassId,
      studentCount: transferredCount,
    },
  });

  revalidatePath("/admin/students");
  revalidatePath("/admin/structure");

  return { targetClassId, transferredCount };
}
