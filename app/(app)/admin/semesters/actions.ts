"use server";

import { revalidatePath } from "next/cache";
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

  // Filter out assignments that already exist BEFORE the transaction:
  // catching a unique-constraint violation mid-transaction doesn't let
  // Postgres carry on to the next statement — the whole transaction is
  // aborted from that point, even though the JS catch block swallows the
  // error. Pre-checking avoids ever hitting that failure (e.g. re-running
  // the wizard after partially opening a semester).
  const existingAssignments = await prisma.lecturerCourseAssignment.findMany({
    where: { semesterId: semester.id },
    select: { lecturerId: true, courseId: true, classId: true },
  });
  const existingKeys = new Set(
    existingAssignments.map((a) => `${a.lecturerId}:${a.courseId}:${a.classId}`)
  );

  const toCreate = data.selections.flatMap((classSelection) =>
    classSelection.courses
      .filter(
        (course) =>
          !existingKeys.has(
            `${course.lecturerId}:${course.courseId}:${classSelection.classId}`
          )
      )
      .map((course) => ({
        lecturerId: course.lecturerId,
        courseId: course.courseId,
        classId: classSelection.classId,
        semesterId: semester.id,
      }))
  );

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

    for (const assignmentData of toCreate) {
      const assignment = await tx.lecturerCourseAssignment.create({
        data: assignmentData,
      });
      assignmentsCreated++;
      const enrolled = await autoEnrollClassIntoAssignment(tx, assignment);
      autoEnrolled.push(...enrolled);
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
