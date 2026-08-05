"use server";

import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { classDeanWhere } from "@/lib/dean-scope";
import {
  parseSpreadsheet,
  assertFileSize,
  assertRowCount,
} from "@/lib/import/parse";
import { buildDataTemplateBase64 } from "@/lib/import/template";
import type { ImportPreviewResult, ImportRowResult } from "@/lib/import/types";
import {
  getScopeFlags,
  finalizeWorkloadImport,
  type WorkloadImportConfirmResult,
} from "./actions";
import type { WorkloadImportRow } from "./schema";
import {
  confirmClassWorkloadImportSchema,
  type ClassWorkloadImportRow,
} from "./class-schema";

const TEMPLATE_COLUMNS = ["course_code", "course_name", "lecturer", "credit_hours"];

// Resolves the ONE class this whole import targets, re-checked against the
// caller's dean scope every call — never trust a classId round-tripped
// from the client without re-verifying (same "ownership-check-IS-the-
// query" idiom as every other dean-scoped lookup in this app).
async function resolveScopedClass(userId: string, classId: string) {
  const { isDean, departmentIds } = await getScopeFlags(userId);
  const cls = await prisma.class.findFirst({
    where: {
      id: classId,
      deletedAt: null,
      ...(isDean ? classDeanWhere(departmentIds) : {}),
    },
    include: { room: { include: { campus: true } } },
  });
  if (!cls) throw new Error("CLASS_NOT_FOUND");
  return cls;
}

// The active Semester is the ONLY one this flow ever targets — there is no
// per-row/per-file semester column anymore. Picking the class up front
// already fixes its currentSemesterNumber level (which course-plan level
// applies); the real academic-calendar Semester the assignment gets
// created under simply defaults to whichever one is currently active,
// same "defaults to the active semester" convention this app already uses
// everywhere else (Assignments panel, Timetable panel, Reports' class
// picker).
async function resolveActiveSemester() {
  const semester = await prisma.semester.findFirst({
    where: { isActive: true },
    include: { academicYear: true },
  });
  if (!semester) throw new Error("NO_ACTIVE_SEMESTER");
  return semester;
}

// Builds a template pre-filled with every course already in this class's
// Course Plan for its CURRENT semester level — course_code/course_name are
// real values read straight from the plan, never freely typed, so a
// course outside that plan can never even appear as a row here; only
// lecturer and credit_hours are left blank for the admin/dean to fill in.
export async function downloadClassWorkloadTemplate(
  classId: string
): Promise<{ base64: string; fileName: string }> {
  const user = await requirePermission("workload.import");
  const cls = await resolveScopedClass(user.id, classId);
  const currentSemesterNumber = cls.currentSemesterNumber;
  if (currentSemesterNumber === null) {
    throw new Error("CLASS_NO_SEMESTER_LEVEL");
  }

  const plan = await prisma.classCoursePlan.findMany({
    where: { classId: cls.id, semesterNumber: currentSemesterNumber },
    include: { course: true },
    orderBy: { course: { name: "asc" } },
  });
  if (plan.length === 0) {
    throw new Error("CLASS_NO_COURSE_PLAN");
  }

  const rows = plan.map((p) => [p.course.code, p.course.name, "", ""]);
  const base64 = buildDataTemplateBase64(TEMPLATE_COLUMNS, rows, "Workload");
  const safeName = cls.name.replace(/[^a-z0-9.-]+/gi, "_");
  return {
    base64,
    fileName: `workload-${safeName}-semester${currentSemesterNumber}.xlsx`,
  };
}

// Custom preview (same OK/DUPLICATE_IN_FILE/ALREADY_EXISTS/ERROR shape as
// previewWorkloadImport in actions.ts) scoped to exactly ONE class + the
// currently active Semester. course_code is matched ONLY against courses
// already in THIS class's plan at its current level — a code belonging to
// some other course (typo, hand-edited row, a template downloaded for a
// different class) is a real ERROR, never silently accepted, which is
// what makes "a course not in this class's plan can never appear as an
// option" hold even against a tampered file, not just the happy path.
export async function previewClassWorkloadImport(
  classId: string,
  formData: FormData
): Promise<ImportPreviewResult<ClassWorkloadImportRow>> {
  const user = await requirePermission("workload.import");
  const cls = await resolveScopedClass(user.id, classId);
  const currentSemesterNumber = cls.currentSemesterNumber;
  if (currentSemesterNumber === null) {
    throw new Error("CLASS_NO_SEMESTER_LEVEL");
  }
  const semester = await resolveActiveSemester();

  const file = formData.get("file");
  if (!(file instanceof File)) throw new Error("NO_FILE");
  assertFileSize(file.size);

  const buffer = await file.arrayBuffer();
  const { rows } = parseSpreadsheet(buffer);
  assertRowCount(rows.length);

  const [plan, lecturers, existing] = await Promise.all([
    prisma.classCoursePlan.findMany({
      where: { classId: cls.id, semesterNumber: currentSemesterNumber },
      include: { course: true },
    }),
    prisma.lecturer.findMany(),
    prisma.lecturerCourseAssignment.findMany({
      where: { classId: cls.id, semesterId: semester.id },
      include: { lecturer: true },
    }),
  ]);

  const coursesByCode = new Map(
    plan.map((p) => [p.course.code.trim().toLowerCase(), p.course])
  );
  const lecturersByStaffNo = new Map(
    lecturers.map((l) => [l.staffNo.trim().toLowerCase(), l])
  );
  const lecturersByFullName = new Map<string, typeof lecturers>();
  for (const l of lecturers) {
    const key = l.fullName.trim().toLowerCase();
    lecturersByFullName.set(key, [...(lecturersByFullName.get(key) ?? []), l]);
  }
  const existingByCourseId = new Map(existing.map((a) => [a.courseId, a]));

  interface LocalValid {
    rowNumber: number;
    display: Record<string, string>;
    data: ClassWorkloadImportRow;
  }
  const localErrors: ImportRowResult<ClassWorkloadImportRow>[] = [];
  const localValid: LocalValid[] = [];

  for (const row of rows) {
    const courseCodeCell = (row.cells["course_code"] ?? "").trim();
    const courseNameCell = (row.cells["course_name"] ?? "").trim();
    const lecturerCell = (row.cells["lecturer"] ?? "").trim();
    const creditHoursCell = (row.cells["credit_hours"] ?? "").trim();

    const display = {
      course_code: courseCodeCell,
      course_name: courseNameCell,
      lecturer: lecturerCell,
      credit_hours: creditHoursCell,
    };

    const issues: string[] = [];

    // Course — matched ONLY against this class's own plan at its current
    // level. A code that resolves to a real course but isn't in THIS
    // plan is exactly as invalid as one that doesn't exist at all.
    let course: (typeof plan)[number]["course"] | null = null;
    if (!courseCodeCell) {
      issues.push("Missing course_code");
    } else {
      const found = coursesByCode.get(courseCodeCell.toLowerCase());
      if (!found) {
        issues.push(
          `Course code "${courseCodeCell}" is not in this class's course plan for semester level ${currentSemesterNumber}`
        );
      } else {
        course = found;
      }
    }

    // Lecturer — same staff_no-preferred / full-name-fallback matching as
    // the multi-class bulk flow.
    let lecturerId: string | null = null;
    let lecturerName = "";
    if (!lecturerCell) {
      issues.push("Missing lecturer");
    } else {
      const byStaffNo = lecturersByStaffNo.get(lecturerCell.toLowerCase());
      if (byStaffNo) {
        lecturerId = byStaffNo.id;
        lecturerName = byStaffNo.fullName;
      } else {
        const byName = lecturersByFullName.get(lecturerCell.toLowerCase()) ?? [];
        if (byName.length === 1) {
          lecturerId = byName[0].id;
          lecturerName = byName[0].fullName;
        } else if (byName.length > 1) {
          issues.push(`Ambiguous lecturer "${lecturerCell}" — use their staff number instead`);
        } else {
          issues.push(`Unknown lecturer "${lecturerCell}"`);
        }
      }
    }

    // Credit hours
    let creditHours: number | null = null;
    if (!creditHoursCell) {
      issues.push("Missing credit_hours");
    } else {
      const parsed = Number(creditHoursCell);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        issues.push(`Invalid credit_hours "${creditHoursCell}" (must be a positive number)`);
      } else {
        creditHours = parsed;
      }
    }

    if (issues.length > 0 || !course || !lecturerId || creditHours === null) {
      localErrors.push({
        rowNumber: row.rowNumber,
        status: "ERROR",
        reason: issues.join("; ") || "Invalid row",
        display,
        data: null,
      });
      continue;
    }

    localValid.push({
      rowNumber: row.rowNumber,
      display,
      data: {
        courseId: course.id,
        courseCode: course.code,
        courseName: course.name,
        lecturerId,
        lecturerName,
        creditHours,
      },
    });
  }

  // Duplicate-in-file: every row sharing the same course is flagged, not
  // just the 2nd+ occurrence (same convention as every other import in
  // this app) — a course can only ever have one lecturer per class+semester.
  const keyCounts = new Map<string, number>();
  for (const v of localValid) {
    keyCounts.set(v.data.courseId, (keyCounts.get(v.data.courseId) ?? 0) + 1);
  }

  const okRows: ImportRowResult<ClassWorkloadImportRow>[] = [];
  const otherRows: ImportRowResult<ClassWorkloadImportRow>[] = [];

  for (const v of localValid) {
    if ((keyCounts.get(v.data.courseId) ?? 0) > 1) {
      otherRows.push({
        rowNumber: v.rowNumber,
        status: "DUPLICATE_IN_FILE",
        reason: "Same course appears more than once in this file",
        display: v.display,
        data: null,
      });
      continue;
    }
    const existingAssignment = existingByCourseId.get(v.data.courseId);
    if (existingAssignment) {
      if (existingAssignment.lecturerId === v.data.lecturerId) {
        otherRows.push({
          rowNumber: v.rowNumber,
          status: "ALREADY_EXISTS",
          reason: "Already assigned to the same lecturer — will be skipped",
          display: v.display,
          data: null,
        });
      } else {
        otherRows.push({
          rowNumber: v.rowNumber,
          status: "ERROR",
          reason: `Lecturer conflict: this course already has a different lecturer (${existingAssignment.lecturer.fullName})`,
          display: v.display,
          data: null,
        });
      }
      continue;
    }
    okRows.push({
      rowNumber: v.rowNumber,
      status: "OK",
      reason: null,
      display: v.display,
      data: v.data,
    });
  }

  const allRows = [...localErrors, ...otherRows, ...okRows].sort(
    (a, b) => a.rowNumber - b.rowNumber
  );

  return {
    rows: allRows,
    counts: {
      ok: allRows.filter((r) => r.status === "OK").length,
      duplicate: allRows.filter((r) => r.status === "DUPLICATE_IN_FILE").length,
      alreadyExists: allRows.filter((r) => r.status === "ALREADY_EXISTS").length,
      error: allRows.filter((r) => r.status === "ERROR").length,
    },
  };
}

// Confirms the OK rows for exactly ONE class, delegating the actual
// creation/audit/summary work to the SAME finalizeWorkloadImport helper
// the multi-class bulk flow uses (actions.ts) — this is what guarantees
// the success dialog and "Continue to auto-generate timetable" handoff
// behave identically regardless of which flow created the assignments.
export async function confirmClassWorkloadImport(
  classId: string,
  input: ClassWorkloadImportRow[],
  fileName: string,
  errorsInFile = 0
): Promise<WorkloadImportConfirmResult> {
  const admin = await requirePermission("workload.import");
  const rows = confirmClassWorkloadImportSchema.parse(input);

  // Re-verify the class is still in scope AND still has a semester
  // level — confirm is a separate server call from preview and must
  // never trust anything round-tripped from the client (same
  // defense-in-depth as every other confirm action in this app).
  const cls = await resolveScopedClass(admin.id, classId);
  const currentSemesterNumber = cls.currentSemesterNumber;
  if (rows.length === 0 || currentSemesterNumber === null) {
    return finalizeWorkloadImport(admin.id, [], rows.length, fileName, errorsInFile);
  }
  const semester = await resolveActiveSemester();

  const fullRows: WorkloadImportRow[] = rows.map((r) => ({
    semesterId: semester.id,
    semesterLabel: `${semester.name} (${semester.academicYear.name})`,
    classId: cls.id,
    className: cls.name,
    classCurrentSemesterNumber: currentSemesterNumber,
    studyMode: cls.studyMode,
    classRoomId: cls.roomId,
    classRoomLabel: cls.room ? `${cls.room.name} — ${cls.room.campus.name}` : null,
    courseId: r.courseId,
    courseName: r.courseName,
    lecturerId: r.lecturerId,
    lecturerName: r.lecturerName,
    creditHours: r.creditHours,
  }));

  return finalizeWorkloadImport(admin.id, fullRows, rows.length, fileName, errorsInFile);
}
