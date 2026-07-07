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
  semesterSchema,
  type SemesterInput,
  openSemesterSchema,
  type OpenSemesterInput,
} from "./schema";

export async function createSemester(input: SemesterInput) {
  await requireRole("ADMIN");
  const data = semesterSchema.parse(input);
  await prisma.semester.create({
    data: {
      name: data.name,
      academicYearId: data.academicYearId,
      startDate: new Date(data.startDate),
      endDate: new Date(data.endDate),
    },
  });
  revalidatePath("/admin/calendar");
}

export async function updateSemester(id: string, input: SemesterInput) {
  await requireRole("ADMIN");
  const data = semesterSchema.parse(input);

  const existing = await prisma.semester.findUniqueOrThrow({ where: { id } });
  if (existing.isClosed) {
    throw new Error("CLOSED_SEMESTER");
  }

  await prisma.semester.update({
    where: { id },
    data: {
      name: data.name,
      academicYearId: data.academicYearId,
      startDate: new Date(data.startDate),
      endDate: new Date(data.endDate),
    },
  });
  revalidatePath("/admin/calendar");
}

// "Open semester" is the only way to activate a semester: it makes this
// the single globally-active semester (deactivating any other active
// semester, regardless of academic year), bulk-creates
// LecturerCourseAssignments from each selected class's course plan, and
// auto-enrolls every current student of those classes — all in one
// transaction.
export async function openSemester(input: OpenSemesterInput) {
  const admin = await requireRole("ADMIN");
  const data = openSemesterSchema.parse(input);

  const semester = await prisma.semester.findUniqueOrThrow({
    where: { id: data.semesterId },
  });
  if (semester.isClosed) {
    throw new Error("CLOSED_SEMESTER");
  }

  let assignmentsCreated = 0;
  const autoEnrolled: AutoEnrolledRecord[] = [];

  await prisma.$transaction(async (tx) => {
    await tx.semester.updateMany({
      where: { isActive: true, NOT: { id: semester.id } },
      data: { isActive: false },
    });
    await tx.semester.update({
      where: { id: semester.id },
      data: { isActive: true },
    });

    for (const classSelection of data.selections) {
      for (const course of classSelection.courses) {
        try {
          const assignment = await tx.lecturerCourseAssignment.create({
            data: {
              lecturerId: course.lecturerId,
              courseId: course.courseId,
              classId: classSelection.classId,
              semesterId: semester.id,
            },
          });
          assignmentsCreated++;
          const enrolled = await autoEnrollClassIntoAssignment(tx, assignment);
          autoEnrolled.push(...enrolled);
        } catch (error) {
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === "P2002"
          ) {
            continue; // this exact assignment already exists — skip
          }
          throw error;
        }
      }
    }
  });

  await audit({
    userId: admin.id,
    action: "SEMESTER_OPENED",
    entity: "Semester",
    entityId: semester.id,
    newValue: {
      classesOpened: data.selections.length,
      assignmentsCreated,
    },
  });
  await auditAutoEnrollments(admin.id, autoEnrolled);

  revalidatePath("/admin/calendar");
  revalidatePath("/admin/curriculum");
  revalidatePath("/admin/students");
}
