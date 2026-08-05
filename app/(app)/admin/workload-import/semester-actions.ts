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
  confirmSemesterWorkloadImportSchema,
  type SemesterWorkloadImportRow,
} from "./semester-schema";

const TEMPLATE_COLUMNS = [
  "semester_level",
  "class",
  "course_code",
  "course_name",
  "lecturer",
  "credit_hours",
];

// Resolves every class this whole import targets: dean-scoped, currently
// at one of the picked semester levels. Re-derived fresh on every call
// (download/preview/confirm) — never trust a semesterNumbers array or the
// resulting class set round-tripped from the client without re-verifying,
// same "ownership-check-IS-the-query" idiom as every other dean-scoped
// lookup in this app.
async function resolveCandidateClasses(userId: string, semesterNumbers: number[]) {
  if (semesterNumbers.length === 0) {
    throw new Error("NO_SEMESTER_NUMBERS_SELECTED");
  }
  const { isDean, departmentIds } = await getScopeFlags(userId);
  return prisma.class.findMany({
    where: {
      deletedAt: null,
      currentSemesterNumber: { in: semesterNumbers },
      ...(isDean ? classDeanWhere(departmentIds) : {}),
    },
    include: { room: { include: { campus: true } } },
    orderBy: [{ currentSemesterNumber: "asc" }, { name: "asc" }],
  });
}

// The active Semester is the ONLY one this flow ever targets — same
// "defaults to the active semester" convention as the per-class flow and
// every other picker in this app (Assignments, Timetable, Reports).
async function resolveActiveSemester() {
  const semester = await prisma.semester.findFirst({
    where: { isActive: true },
    include: { academicYear: true },
  });
  if (!semester) throw new Error("NO_ACTIVE_SEMESTER");
  return semester;
}

// Every ClassCoursePlan row for the given classes, filtered to EXACTLY
// each class's OWN currentSemesterNumber — deliberately NOT just "plan
// rows at any of the selected levels", since ClassCoursePlan recurs per
// class across 1..8 and a class could coincidentally have plan rows
// filed under a DIFFERENT selected level too (e.g. semesterNumbers=[1,3]
// and a class currently at level 1 that also has old/future plan rows at
// level 3 — those must never leak into this class's template).
async function getRelevantPlanRows(classes: Awaited<ReturnType<typeof resolveCandidateClasses>>) {
  const classById = new Map(classes.map((c) => [c.id, c]));
  const allPlans = await prisma.classCoursePlan.findMany({
    where: { classId: { in: classes.map((c) => c.id) } },
    include: { course: true },
  });
  return allPlans.filter(
    (p) => classById.get(p.classId)?.currentSemesterNumber === p.semesterNumber
  );
}

// Builds a template with one row per (class, course) combination across
// EVERY class currently at one of the picked semester levels —
// semester_level/class/course_code/course_name are all real values read
// straight from the DB, never freely typed, so a course outside a given
// class's own plan can never even appear as a row here; only lecturer and
// credit_hours are left blank for the admin/dean to fill in.
export async function downloadSemesterWorkloadTemplate(
  semesterNumbers: number[]
): Promise<{ base64: string; fileName: string }> {
  const user = await requirePermission("workload.import");
  const classes = await resolveCandidateClasses(user.id, semesterNumbers);
  if (classes.length === 0) {
    throw new Error("NO_CLASSES_FOUND");
  }

  const plans = await getRelevantPlanRows(classes);
  if (plans.length === 0) {
    throw new Error("NO_COURSE_PLANS_FOUND");
  }

  const classById = new Map(classes.map((c) => [c.id, c]));
  const rows = plans
    .slice()
    .sort((a, b) => {
      const classA = classById.get(a.classId)!;
      const classB = classById.get(b.classId)!;
      return (
        (classA.currentSemesterNumber ?? 0) - (classB.currentSemesterNumber ?? 0) ||
        classA.name.localeCompare(classB.name) ||
        a.course.name.localeCompare(b.course.name)
      );
    })
    .map((p) => {
      const cls = classById.get(p.classId)!;
      return [
        String(cls.currentSemesterNumber ?? ""),
        cls.name,
        p.course.code,
        p.course.name,
        "",
        "",
      ];
    });

  const base64 = buildDataTemplateBase64(TEMPLATE_COLUMNS, rows, "Workload");
  const levelsLabel = [...new Set(semesterNumbers)].sort((a, b) => a - b).join("-");
  return {
    base64,
    fileName: `workload-semesters-${levelsLabel}.xlsx`,
  };
}

// Custom preview (same OK/DUPLICATE_IN_FILE/ALREADY_EXISTS/ERROR shape as
// previewWorkloadImport/previewClassWorkloadImport) scoped to every class
// currently at one of the picked semester levels + the currently active
// Semester. `class` is matched ONLY within that resolved candidate set,
// and `course_code` ONLY against THAT specific class's own plan at its
// own level — a class outside the selected levels, or a course code
// belonging to some other class/course, is a real ERROR, never silently
// accepted. This is what makes "a course not in a class's plan can never
// appear as an option" hold even against a hand-edited file, not just the
// happy path.
export async function previewSemesterWorkloadImport(
  semesterNumbers: number[],
  formData: FormData
): Promise<ImportPreviewResult<SemesterWorkloadImportRow>> {
  const user = await requirePermission("workload.import");
  const classes = await resolveCandidateClasses(user.id, semesterNumbers);
  const semester = await resolveActiveSemester();

  const file = formData.get("file");
  if (!(file instanceof File)) throw new Error("NO_FILE");
  assertFileSize(file.size);

  const buffer = await file.arrayBuffer();
  const { rows } = parseSpreadsheet(buffer);
  assertRowCount(rows.length);

  const [plans, lecturers, existing] = await Promise.all([
    getRelevantPlanRows(classes),
    prisma.lecturer.findMany(),
    classes.length > 0
      ? prisma.lecturerCourseAssignment.findMany({
          where: {
            classId: { in: classes.map((c) => c.id) },
            semesterId: semester.id,
          },
          include: { lecturer: true },
        })
      : Promise.resolve([]),
  ]);

  // Classes with the SAME name are vanishingly rare (Class.name is unique
  // per program) but not impossible across programs — grouped so an
  // ambiguous match is a real ERROR, never a silent guess.
  const classesByName = new Map<string, typeof classes>();
  for (const c of classes) {
    const key = c.name.trim().toLowerCase();
    classesByName.set(key, [...(classesByName.get(key) ?? []), c]);
  }
  // Course lookup scoped to a SPECIFIC class's own plan, keyed by
  // `${classId}:${courseCode}` — never a bare course-code lookup, which
  // is exactly what would let a course from a different class's plan
  // slip through.
  const coursesByClassAndCode = new Map(
    plans.map((p) => [`${p.classId}:${p.course.code.trim().toLowerCase()}`, p.course])
  );
  const lecturersByStaffNo = new Map(
    lecturers.map((l) => [l.staffNo.trim().toLowerCase(), l])
  );
  const lecturersByFullName = new Map<string, typeof lecturers>();
  for (const l of lecturers) {
    const key = l.fullName.trim().toLowerCase();
    lecturersByFullName.set(key, [...(lecturersByFullName.get(key) ?? []), l]);
  }
  const existingByClassAndCourse = new Map(
    existing.map((a) => [`${a.classId}:${a.courseId}`, a])
  );

  interface LocalValid {
    rowNumber: number;
    display: Record<string, string>;
    data: SemesterWorkloadImportRow;
  }
  const localErrors: ImportRowResult<SemesterWorkloadImportRow>[] = [];
  const localValid: LocalValid[] = [];

  for (const row of rows) {
    const semesterLevelCell = (row.cells["semester_level"] ?? "").trim();
    const classCell = (row.cells["class"] ?? "").trim();
    const courseCodeCell = (row.cells["course_code"] ?? "").trim();
    const courseNameCell = (row.cells["course_name"] ?? "").trim();
    const lecturerCell = (row.cells["lecturer"] ?? "").trim();
    const creditHoursCell = (row.cells["credit_hours"] ?? "").trim();

    const display = {
      semester_level: semesterLevelCell,
      class: classCell,
      course_code: courseCodeCell,
      course_name: courseNameCell,
      lecturer: lecturerCell,
      credit_hours: creditHoursCell,
    };

    const issues: string[] = [];

    // Class — matched ONLY within the resolved candidate set (dean scope
    // + the picked semester levels). Note: semester_level itself is
    // purely informational display, not part of matching — the class
    // name alone (within this scoped set) is the real key.
    let cls: (typeof classes)[number] | null = null;
    if (!classCell) {
      issues.push("Missing class");
    } else {
      const matches = classesByName.get(classCell.toLowerCase()) ?? [];
      if (matches.length === 0) {
        issues.push(
          `Class "${classCell}" is not among the selected semester levels`
        );
      } else if (matches.length > 1) {
        issues.push(`Ambiguous class "${classCell}" — contact an admin`);
      } else {
        cls = matches[0];
      }
    }

    // Course — matched ONLY against the RESOLVED class's own plan at its
    // own level. A code that resolves to a real course but not in THIS
    // class's plan is exactly as invalid as one that doesn't exist.
    let course: { id: string; code: string; name: string } | null = null;
    if (cls) {
      if (!courseCodeCell) {
        issues.push("Missing course_code");
      } else {
        const found = coursesByClassAndCode.get(
          `${cls.id}:${courseCodeCell.toLowerCase()}`
        );
        if (!found) {
          issues.push(
            `Course code "${courseCodeCell}" is not in "${cls.name}"'s course plan for semester level ${cls.currentSemesterNumber}`
          );
        } else {
          course = found;
        }
      }
    } else if (!courseCodeCell) {
      issues.push("Missing course_code");
    }

    // Lecturer — same staff_no-preferred / full-name-fallback matching as
    // every other workload import variant.
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

    if (issues.length > 0 || !cls || !course || !lecturerId || creditHours === null) {
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
        classId: cls.id,
        className: cls.name,
        classCurrentSemesterNumber: cls.currentSemesterNumber,
        courseId: course.id,
        courseCode: course.code,
        courseName: course.name,
        lecturerId,
        lecturerName,
        creditHours,
      },
    });
  }

  // Duplicate-in-file: every row sharing the same (class, course) pair is
  // flagged, not just the 2nd+ occurrence (same convention as every other
  // import in this app) — a course can only ever have one lecturer per
  // class+semester.
  const keyOf = (d: SemesterWorkloadImportRow) => `${d.classId}:${d.courseId}`;
  const keyCounts = new Map<string, number>();
  for (const v of localValid) {
    const key = keyOf(v.data);
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  }

  const okRows: ImportRowResult<SemesterWorkloadImportRow>[] = [];
  const otherRows: ImportRowResult<SemesterWorkloadImportRow>[] = [];

  for (const v of localValid) {
    const key = keyOf(v.data);
    if ((keyCounts.get(key) ?? 0) > 1) {
      otherRows.push({
        rowNumber: v.rowNumber,
        status: "DUPLICATE_IN_FILE",
        reason: "Same class+course appears more than once in this file",
        display: v.display,
        data: null,
      });
      continue;
    }
    const existingAssignment = existingByClassAndCourse.get(key);
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
          reason: `Lecturer conflict: this course in this class already has a different lecturer (${existingAssignment.lecturer.fullName})`,
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

// Confirms the OK rows across every class in the selected semester
// levels, delegating the actual creation/audit/summary work to the SAME
// finalizeWorkloadImport helper every workload-import variant uses
// (actions.ts) — one transaction across ALL classes/semesters in this one
// file, exactly like Bulk Assign already handles one lecturer across many
// rows.
export async function confirmSemesterWorkloadImport(
  semesterNumbers: number[],
  input: SemesterWorkloadImportRow[],
  fileName: string,
  errorsInFile = 0
): Promise<WorkloadImportConfirmResult> {
  const admin = await requirePermission("workload.import");
  const rows = confirmSemesterWorkloadImportSchema.parse(input);

  // Re-verify every submitted class is still in scope AND still at one of
  // the selected levels — confirm is a separate server call from preview
  // and must never trust anything round-tripped from the client (same
  // defense-in-depth as every other confirm action in this app).
  // Out-of-scope rows are silently excluded from creation, not just from
  // the count of "created" — they never touch the DB.
  const classes = await resolveCandidateClasses(admin.id, semesterNumbers);
  const classById = new Map(classes.map((c) => [c.id, c]));
  const scopedRows = rows.filter((r) => classById.has(r.classId));

  if (scopedRows.length === 0) {
    return finalizeWorkloadImport(admin.id, [], rows.length, fileName, errorsInFile);
  }
  const semester = await resolveActiveSemester();

  const fullRows: WorkloadImportRow[] = scopedRows.map((r) => {
    const cls = classById.get(r.classId)!;
    return {
      semesterId: semester.id,
      semesterLabel: `${semester.name} (${semester.academicYear.name})`,
      classId: cls.id,
      className: cls.name,
      classCurrentSemesterNumber: cls.currentSemesterNumber,
      studyMode: cls.studyMode,
      classRoomId: cls.roomId,
      classRoomLabel: cls.room ? `${cls.room.name} — ${cls.room.campus.name}` : null,
      courseId: r.courseId,
      courseName: r.courseName,
      lecturerId: r.lecturerId,
      lecturerName: r.lecturerName,
      creditHours: r.creditHours,
    };
  });

  return finalizeWorkloadImport(admin.id, fullRows, rows.length, fileName, errorsInFile);
}
