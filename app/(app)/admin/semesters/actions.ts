"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
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

const MAX_SEMESTER_NUMBER = 8;

// Semester 1/2 is a dropdown, not free text — an academic year can have
// at most one of each. Pre-checked before create/update (not caught via
// the DB's unique constraint after the fact) so the error can name the
// conflicting number directly, same pattern as every other duplicate
// guard in this app (see CLAUDE.md conventions).
export async function createSemester(input: SemesterInput) {
  await requirePermission("calendar.manage");
  const data = semesterSchema.parse(input);
  const semesterNumber = Number(data.semesterNumber);

  const existing = await prisma.semester.findFirst({
    where: { academicYearId: data.academicYearId, semesterNumber },
  });
  if (existing) {
    throw new Error(`This academic year already has Semester ${semesterNumber}.`);
  }

  await prisma.semester.create({
    data: {
      name: `Semester ${semesterNumber}`,
      semesterNumber,
      academicYearId: data.academicYearId,
      startDate: new Date(data.startDate),
      endDate: new Date(data.endDate),
    },
  });
  revalidatePath("/admin/calendar");
}

export async function updateSemester(id: string, input: SemesterInput) {
  await requirePermission("calendar.manage");
  const data = semesterSchema.parse(input);
  const semesterNumber = Number(data.semesterNumber);

  const existing = await prisma.semester.findUniqueOrThrow({ where: { id } });
  if (existing.isClosed) {
    throw new Error("CLOSED_SEMESTER");
  }

  const conflict = await prisma.semester.findFirst({
    where: {
      academicYearId: data.academicYearId,
      semesterNumber,
      NOT: { id },
    },
  });
  if (conflict) {
    throw new Error(`This academic year already has Semester ${semesterNumber}.`);
  }

  await prisma.semester.update({
    where: { id },
    data: {
      name: `Semester ${semesterNumber}`,
      semesterNumber,
      academicYearId: data.academicYearId,
      startDate: new Date(data.startDate),
      endDate: new Date(data.endDate),
    },
  });
  revalidatePath("/admin/calendar");
}

// "Open semester" is the only way to activate a semester: it makes this
// the single globally-active semester (deactivating any other active
// semester, regardless of academic year), advances each included class's
// currentSemesterNumber (batches never change class rows — only this
// number moves), bulk-creates LecturerCourseAssignments from each
// resulting semester-level's course plan, and auto-enrolls every current
// student of those classes — all in one transaction.
export async function openSemester(input: OpenSemesterInput) {
  const admin = await requirePermission("semester.open");
  const data = openSemesterSchema.parse(input);

  const semester = await prisma.semester.findUniqueOrThrow({
    where: { id: data.semesterId },
  });
  if (semester.isClosed) {
    throw new Error("CLOSED_SEMESTER");
  }

  const classes = data.classes.length
    ? await prisma.class.findMany({
        where: { id: { in: data.classes.map((c) => c.classId) } },
        select: { id: true, name: true, currentSemesterNumber: true },
      })
    : [];
  const classById = new Map(classes.map((c) => [c.id, c]));

  // The class's course plan at the resolved semester level is the
  // authoritative course list — client input only supplies lecturer
  // picks, never arbitrary course ids.
  const resolved = data.classes.map((entry) => {
    const cls = classById.get(entry.classId);
    if (!cls || cls.currentSemesterNumber === null) {
      throw new Error("CLASS_NOT_SET_UP");
    }
    const newSemesterNumber = entry.advance
      ? cls.currentSemesterNumber + 1
      : cls.currentSemesterNumber;
    if (newSemesterNumber > MAX_SEMESTER_NUMBER) {
      throw new Error("MAX_SEMESTER_REACHED");
    }
    return { ...entry, newSemesterNumber };
  });

  const planRows = resolved.length
    ? await prisma.classCoursePlan.findMany({
        where: {
          OR: resolved.map((r) => ({
            classId: r.classId,
            semesterNumber: r.newSemesterNumber,
          })),
        },
        include: { course: true },
      })
    : [];
  const planByClass = new Map<string, typeof planRows>();
  for (const row of planRows) {
    planByClass.set(row.classId, [...(planByClass.get(row.classId) ?? []), row]);
  }

  for (const entry of resolved) {
    for (const plan of planByClass.get(entry.classId) ?? []) {
      if (!entry.lecturerByCourse[plan.courseId]) {
        throw new Error("MISSING_LECTURER");
      }
    }
  }

  // Pre-check assignments that already exist BEFORE the transaction:
  // catching a unique-constraint violation mid-transaction doesn't let
  // Postgres carry on to the next statement — the whole transaction is
  // aborted from that point, even though the JS catch block swallows the
  // error. Pre-checking avoids ever hitting that failure (e.g. re-running
  // the wizard after partially opening a semester) and — since a
  // course+class+semester can only ever have ONE lecturer — lets us tell
  // "already assigned to the same lecturer" (skip, not an error) apart
  // from "already assigned to a DIFFERENT lecturer" (a real conflict,
  // reported with that lecturer's name rather than left to fail inside
  // the transaction).
  const existingAssignments = await prisma.lecturerCourseAssignment.findMany({
    where: { semesterId: semester.id },
    include: { lecturer: { include: { user: true } } },
  });
  const existingByKey = new Map(
    existingAssignments.map((a) => [
      `${a.courseId}:${a.classId}`,
      { lecturerId: a.lecturerId, lecturerName: a.lecturer.user.fullName },
    ])
  );

  const conflicts: string[] = [];
  const toCreate: {
    lecturerId: string;
    courseId: string;
    classId: string;
    semesterId: string;
  }[] = [];

  for (const entry of resolved) {
    const cls = classById.get(entry.classId);
    for (const plan of planByClass.get(entry.classId) ?? []) {
      const lecturerId = entry.lecturerByCourse[plan.courseId];
      const existing = existingByKey.get(`${plan.courseId}:${entry.classId}`);
      if (existing) {
        if (existing.lecturerId !== lecturerId) {
          conflicts.push(
            `${plan.course.name} in ${cls?.name ?? entry.classId} already has a lecturer (${existing.lecturerName}). Use Dean ownership transfer to replace them.`
          );
        }
        continue; // already assigned to this same lecturer — skip, not an error
      }
      toCreate.push({
        lecturerId,
        courseId: plan.courseId,
        classId: entry.classId,
        semesterId: semester.id,
      });
    }
  }

  if (conflicts.length > 0) {
    throw new Error(conflicts.join(" "));
  }

  const advancing = resolved.filter((r) => r.advance);

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

    for (const cls of advancing) {
      await tx.class.update({
        where: { id: cls.classId },
        data: { currentSemesterNumber: cls.newSemesterNumber },
      });
    }

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
      classesAdvanced: advancing.length,
      assignmentsCreated,
    },
  });
  await auditAutoEnrollments(admin.id, autoEnrolled);

  revalidatePath("/admin/calendar");
  revalidatePath("/admin/curriculum");
  revalidatePath("/admin/students");
}
