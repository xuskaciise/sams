"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { audit } from "@/lib/audit";
import {
  parseSpreadsheet,
  assertFileSize,
  assertRowCount,
} from "@/lib/import/parse";
import { buildTemplateBase64 } from "@/lib/import/template";
import { buildPreview, type RowValidation } from "@/lib/import/preview";
import type { ImportPreviewResult } from "@/lib/import/types";

// Historical Enrollments Import — a bulk backfill tool for
// StudentCourseEnrollment records that were never entered when the
// system launched (e.g. a student now at semester level 7 with nothing
// recorded for levels 1-6). Deliberately separate from every OTHER way
// an enrollment gets created in this app (student registration, class
// transfer, a new LecturerCourseAssignment, the Open Semester wizard,
// Workload Import — all of which go through lib/enrollment.ts's
// autoEnrollStudentIntoClassCourses/autoEnrollClassIntoAssignment) —
// this is pure historical record-keeping, not a real-time enrollment
// event, so it NEVER calls those helpers and therefore never fires
// their side effects (no WhatsApp/email notify, nothing semester-open-
// adjacent). A single, direct `createMany` is the only write.
export interface HistoricalEnrollmentImportRow {
  studentId: string;
  courseId: string;
  classId: string;
  semesterId: string;
}

const TEMPLATE_COLUMNS = [
  { header: "student_no", example1: "S1001", example2: "S1002" },
  { header: "course_code", example1: "CS101", example2: "CS205" },
  { header: "semester_level", example1: "1", example2: "3" },
  { header: "year", example1: "2022-2023", example2: "2022-2023" },
];

export async function downloadHistoricalEnrollmentImportTemplate() {
  await requirePermission("enrollments.manage");
  return {
    base64: buildTemplateBase64(TEMPLATE_COLUMNS, "Historical Enrollments"),
    fileName: "historical-enrollments-import-template.xlsx",
  };
}

// A batch's cycle level (1..8) maps to a real Academic Calendar Semester
// NUMBER (1 or 2) by the same odd/even parity rule already established
// for auto-timetable eligibility (see
// lib/auto-timetable.ts's parityForAcademicSemesterNumber, which goes
// the opposite direction — a real semesterNumber to a parity — this is
// the inverse: a level to the semesterNumber it implies) and for the
// Missed Exam Registration Form 2 filter: odd levels (1,3,5,7) belong to
// that academic year's Semester 1, even levels (2,4,6,8) to Semester 2.
function requiredAcademicSemesterNumberForLevel(level: number): 1 | 2 {
  return level % 2 === 1 ? 1 : 2;
}

export async function previewHistoricalEnrollmentImport(
  formData: FormData
): Promise<ImportPreviewResult<HistoricalEnrollmentImportRow>> {
  await requirePermission("enrollments.manage");

  const file = formData.get("file");
  if (!(file instanceof File)) {
    throw new Error("NO_FILE");
  }
  assertFileSize(file.size);

  const buffer = await file.arrayBuffer();
  const { rows } = parseSpreadsheet(buffer);
  assertRowCount(rows.length);

  const [students, courses, years, semesters, existingEnrollments] =
    await Promise.all([
      prisma.student.findMany({
        select: { id: true, studentNo: true, classId: true },
      }),
      // Deleted courses can't be enrolled into going forward, but a
      // HISTORICAL enrollment against one is still legitimate record-
      // keeping (the course genuinely existed and was taken back then),
      // so soft-deleted courses are deliberately NOT excluded here —
      // unlike every other bulk import in this app, which only ever
      // creates NEW forward-looking rows.
      prisma.course.findMany({ select: { id: true, code: true } }),
      prisma.academicYear.findMany({ select: { id: true, name: true } }),
      prisma.semester.findMany({
        select: { id: true, academicYearId: true, semesterNumber: true },
      }),
      prisma.studentCourseEnrollment.findMany({
        select: { studentId: true, courseId: true, semesterId: true },
      }),
    ]);

  const studentByNo = new Map(
    students.map((s) => [s.studentNo.trim().toLowerCase(), s])
  );
  const courseByCode = new Map(
    courses.map((c) => [c.code.trim().toUpperCase(), c])
  );
  const yearByName = new Map(years.map((y) => [y.name.trim().toLowerCase(), y]));
  const semesterByYearAndNumber = new Map(
    semesters
      .filter((s) => s.semesterNumber !== null)
      .map((s) => [`${s.academicYearId}:${s.semesterNumber}`, s])
  );
  // Duplicate check is on the exact (student, course, semester) triple,
  // regardless of status — "this exact enrollment already exists" is a
  // domain-level statement, not a per-status one; a student is never
  // meant to have two rows for the same course in the same real
  // semester, historical or not.
  const existingKeys = new Set(
    existingEnrollments.map((e) => `${e.studentId}:${e.courseId}:${e.semesterId}`)
  );

  const validations: RowValidation<HistoricalEnrollmentImportRow>[] = rows.map(
    (row) => {
      const studentNo = (row.cells["student_no"] ?? "").trim();
      const courseCode = (row.cells["course_code"] ?? "").trim();
      const semesterLevelRaw = (row.cells["semester_level"] ?? "").trim();
      const yearRaw = (row.cells["year"] ?? "").trim();

      const display = {
        student_no: studentNo,
        course_code: courseCode,
        semester_level: semesterLevelRaw,
        year: yearRaw,
      };

      const issues: string[] = [];

      const student = studentByNo.get(studentNo.toLowerCase());
      if (!studentNo) issues.push("Missing student_no");
      else if (!student) issues.push(`Unknown student_no "${studentNo}"`);

      const course = courseByCode.get(courseCode.toUpperCase());
      if (!courseCode) issues.push("Missing course_code");
      else if (!course) issues.push(`Unknown course_code "${courseCode}"`);

      let semesterLevel: number | null = null;
      if (!semesterLevelRaw) {
        issues.push("Missing semester_level");
      } else {
        const parsed = Number(semesterLevelRaw);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 8) {
          issues.push(
            `Invalid semester_level "${semesterLevelRaw}" (expected a whole number 1-8)`
          );
        } else {
          semesterLevel = parsed;
        }
      }

      const year = yearByName.get(yearRaw.toLowerCase());
      if (!yearRaw) issues.push("Missing year");
      else if (!year) issues.push(`Unknown academic year "${yearRaw}"`);

      // Only resolvable once BOTH the year and a valid level are known —
      // never guessed/created when no matching Semester record exists.
      let semester: { id: string } | null = null;
      if (year && semesterLevel !== null) {
        const requiredNumber = requiredAcademicSemesterNumberForLevel(semesterLevel);
        const match = semesterByYearAndNumber.get(`${year.id}:${requiredNumber}`);
        if (!match) {
          issues.push(
            `No Semester ${requiredNumber} record exists for "${yearRaw}" — create it in Academic Calendar > Semesters first`
          );
        } else {
          semester = match;
        }
      }

      if (issues.length > 0 || !student || !course || !semester) {
        return {
          rowNumber: row.rowNumber,
          display,
          key: null,
          error: issues.join("; "),
          data: null,
        };
      }

      return {
        rowNumber: row.rowNumber,
        display,
        key: `${student.id}:${course.id}:${semester.id}`,
        error: null,
        data: {
          studentId: student.id,
          courseId: course.id,
          // The student's CURRENT class — StudentCourseEnrollment.classId
          // is required, and Student.classId's own schema comment says
          // exactly this: "class-ka hadda (current); taariikhda waxaa
          // haya enrollments" (the CURRENT class; history is held by
          // enrollments) — once created, this row's own classId is what
          // becomes the historical record, regardless of any LATER
          // transfer. For the overwhelming normal case (a batch's class
          // row never changes across a student's 8 semester levels — see
          // the batch/class model business rule), this is exactly
          // correct. The one edge case this can't get right from just
          // (student_no, course_code, semester_level, year) alone: a
          // student who was transferred to a different class row at some
          // point in their history would have their PRE-transfer
          // historical enrollments filed under their CURRENT (post-
          // transfer) class instead of the class they were actually in
          // at the time — an admin can fix that specific row afterward
          // via the Enrollments page's own transfer/edit tools if it
          // matters for a given case.
          classId: student.classId,
          semesterId: semester.id,
        },
      };
    }
  );

  return buildPreview(validations, existingKeys);
}

const confirmRowSchema = z.object({
  studentId: z.string().min(1),
  courseId: z.string().min(1),
  classId: z.string().min(1),
  semesterId: z.string().min(1),
});
const confirmSchema = z.array(confirmRowSchema);

export async function confirmHistoricalEnrollmentImport(
  input: HistoricalEnrollmentImportRow[],
  fileName: string
): Promise<{ created: number }> {
  const admin = await requirePermission("enrollments.manage");
  const rows = confirmSchema.parse(input);
  if (rows.length === 0) return { created: 0 };

  // Re-check right before writing — time may have passed since preview,
  // and this is a single createMany (not a loop inside a transaction),
  // so anything that now conflicts must be filtered out first rather
  // than relying on a unique-constraint failure to abort the whole
  // batch's insert.
  const existing = await prisma.studentCourseEnrollment.findMany({
    where: {
      OR: rows.map((r) => ({
        studentId: r.studentId,
        courseId: r.courseId,
        semesterId: r.semesterId,
      })),
    },
    select: { studentId: true, courseId: true, semesterId: true },
  });
  const existingKeys = new Set(
    existing.map((e) => `${e.studentId}:${e.courseId}:${e.semesterId}`)
  );
  const toCreate = rows.filter(
    (r) => !existingKeys.has(`${r.studentId}:${r.courseId}:${r.semesterId}`)
  );

  if (toCreate.length > 0) {
    // enrolledAt is backdated to the resolved semester's own startDate
    // (never "now") — these rows represent something that happened in
    // the past, not a fresh enrollment event; leaving the default would
    // make a whole backfilled history look like it just happened today
    // in every list/report that sorts or displays by enrolledAt.
    const semesterIds = [...new Set(toCreate.map((r) => r.semesterId))];
    const semesterStartDates = await prisma.semester.findMany({
      where: { id: { in: semesterIds } },
      select: { id: true, startDate: true },
    });
    const startDateBySemesterId = new Map(
      semesterStartDates.map((s) => [s.id, s.startDate])
    );

    // Deliberately NOT autoEnrollStudentIntoClassCourses/
    // autoEnrollClassIntoAssignment (lib/enrollment.ts) — a plain,
    // direct createMany with no auto-enroll fan-out, no notify hooks, no
    // AUTO_ENROLLED audit rows. Status is COMPLETED, not the default
    // ACTIVE, since these are past semesters the student has already
    // finished, not ones they're currently taking.
    await prisma.studentCourseEnrollment.createMany({
      data: toCreate.map((r) => ({
        studentId: r.studentId,
        courseId: r.courseId,
        classId: r.classId,
        semesterId: r.semesterId,
        status: "COMPLETED",
        enrolledAt: startDateBySemesterId.get(r.semesterId) ?? new Date(),
      })),
    });
  }

  await audit({
    userId: admin.id,
    action: "BULK_IMPORT",
    entity: "StudentCourseEnrollment",
    newValue: {
      entityType: "HistoricalEnrollment",
      fileName,
      requested: rows.length,
      created: toCreate.length,
      skipped: rows.length - toCreate.length,
    },
  });

  revalidatePath("/admin/students");
  return { created: toCreate.length };
}
