"use server";

import { revalidatePath } from "next/cache";
import { prisma, BULK_TRANSACTION_OPTIONS } from "@/lib/db";
import { requirePermission, getUserAccess } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getDeanDepartmentIds, classDeanWhere } from "@/lib/dean-scope";
import {
  parseSpreadsheet,
  assertFileSize,
  assertRowCount,
} from "@/lib/import/parse";
import { buildTemplateBase64 } from "@/lib/import/template";
import type { ImportPreviewResult, ImportRowResult } from "@/lib/import/types";
import {
  autoEnrollClassIntoAssignment,
  auditAutoEnrollments,
  type AutoEnrolledRecord,
} from "@/lib/enrollment";
import { confirmWorkloadImportSchema, type WorkloadImportRow } from "./schema";

const TEMPLATE_COLUMNS = [
  { header: "semester", example1: "Semester 1", example2: "Semester 1" },
  { header: "program", example1: "CMS", example2: "CMS" },
  { header: "class", example1: "CMS26-A-FT", example2: "CMS26-A-FT" },
  { header: "course", example1: "Databases", example2: "Networking" },
  { header: "lecturer", example1: "S1001", example2: "Dr. Ahmed Yusuf" },
  { header: "credit_hours", example1: "3", example2: "2.5" },
];

export async function downloadWorkloadImportTemplate() {
  await requirePermission("workload.import");
  return {
    base64: buildTemplateBase64(TEMPLATE_COLUMNS, "Workload"),
    fileName: "workload-import-template.xlsx",
  };
}

// Same "re-derive scope from the caller's role every call" idiom as every
// other dean-scoped feature (Daily Log, Timetable) — never trust which
// route got them here.
async function getScopeFlags(userId: string) {
  const { roleNames } = await getUserAccess(userId);
  const isDean = roleNames.includes("DEAN");
  const departmentIds = isDean ? await getDeanDepartmentIds(userId) : [];
  return { isDean, departmentIds };
}

function makeErrorRow(
  rowNumber: number,
  display: Record<string, string>,
  reason: string
): ImportRowResult<WorkloadImportRow> {
  return { rowNumber, status: "ERROR", reason, display, data: null };
}

// Custom preview (not lib/import/preview.ts's generic buildPreview) — this
// import needs a FOURTH terminal outcome beyond OK/DUPLICATE_IN_FILE/
// ALREADY_EXISTS/ERROR-from-local-validation: an existing assignment for
// the same course+class+semester but a DIFFERENT lecturer is a hard
// conflict (ERROR, never silently overwritten), while the SAME lecturer is
// a harmless no-op (ALREADY_EXISTS). Both still fit the shared
// ImportRowStatus/ImportRowResult shape, so BulkImportDialog needs no
// changes to render this import.
export async function previewWorkloadImport(
  formData: FormData
): Promise<ImportPreviewResult<WorkloadImportRow>> {
  const user = await requirePermission("workload.import");
  const { isDean, departmentIds } = await getScopeFlags(user.id);

  const file = formData.get("file");
  if (!(file instanceof File)) throw new Error("NO_FILE");
  assertFileSize(file.size);

  const buffer = await file.arrayBuffer();
  const { rows } = parseSpreadsheet(buffer);
  assertRowCount(rows.length);

  const [semesters, programs, classes, courses, lecturers, coursePlans] = await Promise.all([
    prisma.semester.findMany({ include: { academicYear: true } }),
    prisma.program.findMany({ where: { deletedAt: null } }),
    prisma.class.findMany({
      where: { deletedAt: null, ...(isDean ? classDeanWhere(departmentIds) : {}) },
      include: { program: true },
    }),
    prisma.course.findMany({ where: { deletedAt: null } }),
    prisma.lecturer.findMany({ include: { user: true } }),
    prisma.classCoursePlan.findMany(),
  ]);

  const semestersByName = new Map<string, typeof semesters>();
  for (const s of semesters) {
    const key = s.name.trim().toLowerCase();
    semestersByName.set(key, [...(semestersByName.get(key) ?? []), s]);
  }
  const programsByCode = new Map(programs.map((p) => [p.code.trim().toLowerCase(), p]));
  const programsByName = new Map(programs.map((p) => [p.name.trim().toLowerCase(), p]));
  const classesByProgramAndName = new Map<string, (typeof classes)[number]>();
  for (const c of classes) {
    classesByProgramAndName.set(`${c.programId}:${c.name.trim().toLowerCase()}`, c);
  }
  const coursesByCode = new Map(courses.map((c) => [c.code.trim().toLowerCase(), c]));
  const coursesByName = new Map<string, typeof courses>();
  for (const c of courses) {
    const key = c.name.trim().toLowerCase();
    coursesByName.set(key, [...(coursesByName.get(key) ?? []), c]);
  }
  const lecturersByStaffNo = new Map(lecturers.map((l) => [l.staffNo.trim().toLowerCase(), l]));
  const lecturersByFullName = new Map<string, typeof lecturers>();
  for (const l of lecturers) {
    const key = l.user.fullName.trim().toLowerCase();
    lecturersByFullName.set(key, [...(lecturersByFullName.get(key) ?? []), l]);
  }
  const plansByClassAndLevel = new Map<string, Set<string>>();
  for (const p of coursePlans) {
    const key = `${p.classId}:${p.semesterNumber}`;
    if (!plansByClassAndLevel.has(key)) plansByClassAndLevel.set(key, new Set());
    plansByClassAndLevel.get(key)!.add(p.courseId);
  }

  interface LocalValid {
    rowNumber: number;
    display: Record<string, string>;
    data: WorkloadImportRow;
  }
  const localErrors: ImportRowResult<WorkloadImportRow>[] = [];
  const localValid: LocalValid[] = [];

  for (const row of rows) {
    const semesterCell = (row.cells["semester"] ?? "").trim();
    const programCell = (row.cells["program"] ?? "").trim();
    const classCell = (row.cells["class"] ?? "").trim();
    const courseCell = (row.cells["course"] ?? "").trim();
    const lecturerCell = (row.cells["lecturer"] ?? "").trim();
    const creditHoursCell = (row.cells["credit_hours"] ?? "").trim();

    const display = {
      semester: semesterCell,
      program: programCell,
      class: classCell,
      course: courseCell,
      lecturer: lecturerCell,
      credit_hours: creditHoursCell,
    };

    const issues: string[] = [];

    // Semester
    let semesterId: string | null = null;
    let semesterLabel = "";
    if (!semesterCell) {
      issues.push("Missing semester");
    } else {
      const matches = semestersByName.get(semesterCell.toLowerCase()) ?? [];
      if (matches.length === 0) {
        issues.push(`Unknown semester "${semesterCell}"`);
      } else if (matches.length === 1) {
        semesterId = matches[0].id;
        semesterLabel = `${matches[0].name} (${matches[0].academicYear.name})`;
      } else {
        const activeMatch = matches.find((m) => m.isActive);
        if (activeMatch) {
          semesterId = activeMatch.id;
          semesterLabel = `${activeMatch.name} (${activeMatch.academicYear.name})`;
        } else {
          issues.push(
            `Ambiguous semester "${semesterCell}" — exists in multiple academic years (${matches
              .map((m) => m.academicYear.name)
              .join(", ")}); none is active`
          );
        }
      }
    }

    // Program
    let programId: string | null = null;
    if (!programCell) {
      issues.push("Missing program");
    } else {
      const program =
        programsByCode.get(programCell.toLowerCase()) ?? programsByName.get(programCell.toLowerCase());
      if (!program) {
        issues.push(`Unknown program "${programCell}"`);
      } else {
        programId = program.id;
      }
    }

    // Class (scoped to program, and to the dean's faculty via the
    // already-filtered `classes` list above)
    let classRow: (typeof classes)[number] | null = null;
    if (!classCell) {
      issues.push("Missing class");
    } else if (programId) {
      const found = classesByProgramAndName.get(`${programId}:${classCell.toLowerCase()}`);
      if (!found) {
        issues.push(`Unknown class "${classCell}" in program "${programCell}"`);
      } else {
        classRow = found;
      }
    }

    // Course
    let courseId: string | null = null;
    let courseName = "";
    if (!courseCell) {
      issues.push("Missing course");
    } else {
      const byCode = coursesByCode.get(courseCell.toLowerCase());
      if (byCode) {
        courseId = byCode.id;
        courseName = byCode.name;
      } else {
        const byName = coursesByName.get(courseCell.toLowerCase()) ?? [];
        if (byName.length === 1) {
          courseId = byName[0].id;
          courseName = byName[0].name;
        } else if (byName.length > 1) {
          issues.push(`Ambiguous course "${courseCell}" — use the course code instead`);
        } else {
          issues.push(`Unknown course "${courseCell}"`);
        }
      }
    }

    // Course-in-plan check (needs both classRow and courseId resolved)
    if (classRow && courseId) {
      if (classRow.currentSemesterNumber === null) {
        issues.push(`Class "${classCell}" has no current semester level set — cannot verify its course plan`);
      } else {
        const planned = plansByClassAndLevel.get(`${classRow.id}:${classRow.currentSemesterNumber}`);
        if (!planned || !planned.has(courseId)) {
          issues.push(
            `Course "${courseCell}" is not in "${classCell}"'s course plan for semester level ${classRow.currentSemesterNumber}`
          );
        }
      }
    }

    // Lecturer
    let lecturerId: string | null = null;
    let lecturerName = "";
    if (!lecturerCell) {
      issues.push("Missing lecturer");
    } else {
      const byStaffNo = lecturersByStaffNo.get(lecturerCell.toLowerCase());
      if (byStaffNo) {
        lecturerId = byStaffNo.id;
        lecturerName = byStaffNo.user.fullName;
      } else {
        const byName = lecturersByFullName.get(lecturerCell.toLowerCase()) ?? [];
        if (byName.length === 1) {
          lecturerId = byName[0].id;
          lecturerName = byName[0].user.fullName;
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

    if (
      issues.length > 0 ||
      !semesterId ||
      !classRow ||
      !courseId ||
      !lecturerId ||
      creditHours === null
    ) {
      localErrors.push(makeErrorRow(row.rowNumber, display, issues.join("; ") || "Invalid row"));
      continue;
    }

    localValid.push({
      rowNumber: row.rowNumber,
      display,
      data: {
        semesterId,
        semesterLabel,
        classId: classRow.id,
        className: classRow.name,
        classCurrentSemesterNumber: classRow.currentSemesterNumber,
        studyMode: classRow.studyMode,
        courseId,
        courseName,
        lecturerId,
        lecturerName,
        creditHours,
      },
    });
  }

  // Duplicate-in-file: every row sharing a (class, course, semester) key is
  // flagged, not just the 2nd+ occurrence — no safe way to guess which is
  // authoritative (same convention as every other import in this app).
  const keyOf = (d: WorkloadImportRow) => `${d.classId}:${d.courseId}:${d.semesterId}`;
  const keyCounts = new Map<string, number>();
  for (const v of localValid) {
    const key = keyOf(v.data);
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  }

  const existing = await prisma.lecturerCourseAssignment.findMany({
    where: {
      OR: localValid.map((v) => ({
        classId: v.data.classId,
        courseId: v.data.courseId,
        semesterId: v.data.semesterId,
      })),
    },
    include: { lecturer: { include: { user: true } } },
  });
  const existingByKey = new Map(
    existing.map((a) => [`${a.classId}:${a.courseId}:${a.semesterId}`, a])
  );

  const okRows: ImportRowResult<WorkloadImportRow>[] = [];
  const otherRows: ImportRowResult<WorkloadImportRow>[] = [];

  for (const v of localValid) {
    const key = keyOf(v.data);
    if ((keyCounts.get(key) ?? 0) > 1) {
      otherRows.push({
        rowNumber: v.rowNumber,
        status: "DUPLICATE_IN_FILE",
        reason: "Same class+course+semester appears more than once in this file",
        display: v.display,
        data: null,
      });
      continue;
    }
    const existingAssignment = existingByKey.get(key);
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
        otherRows.push(
          makeErrorRow(
            v.rowNumber,
            v.display,
            `Lecturer conflict: this course in this class already has a different lecturer (${existingAssignment.lecturer.user.fullName})`
          )
        );
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

  const allRows = [...localErrors, ...otherRows, ...okRows].sort((a, b) => a.rowNumber - b.rowNumber);

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

export interface CreatedAssignmentSummary {
  assignmentId: string;
  lecturerName: string;
  courseName: string;
  className: string;
  classId: string;
  semesterId: string;
  semesterLabel: string;
  classCurrentSemesterNumber: number | null;
  studyMode: "FT" | "PT" | null;
  creditHours: number;
}

export interface WorkloadImportConfirmResult {
  created: number;
  skipped: number;
  // The full original file's error-row count (rows that never even made
  // it into `rows` here, since BulkImportDialog only forwards OK rows to
  // confirm) — passed through purely for an accurate "X new, Y skipped, Z
  // errors" success summary; not trusted for any authorization/creation
  // decision, which is based entirely on `rows` and fresh DB re-checks.
  errorsInFile: number;
  createdAssignments: CreatedAssignmentSummary[];
}

export async function confirmWorkloadImport(
  input: WorkloadImportRow[],
  fileName: string,
  errorsInFile = 0
): Promise<WorkloadImportConfirmResult> {
  const admin = await requirePermission("workload.import");
  const rows = confirmWorkloadImportSchema.parse(input);
  if (rows.length === 0) {
    await audit({
      userId: admin.id,
      action: "WORKLOAD_IMPORTED",
      entity: "LecturerCourseAssignment",
      newValue: { fileName, requested: 0, created: 0, skipped: 0 },
    });
    return { created: 0, skipped: 0, errorsInFile, createdAssignments: [] };
  }

  const { isDean, departmentIds } = await getScopeFlags(admin.id);

  // Re-verify every submitted classId is still in the caller's scope —
  // preview already filtered by it, but confirm is a separate server call
  // that must never trust ids round-tripped from the client without
  // re-checking (same defense-in-depth as every other confirm action in
  // this app). Out-of-scope rows are silently excluded from creation, not
  // just from the count of "created" — they never touch the DB.
  const inScopeClassIds = new Set(
    (
      await prisma.class.findMany({
        where: {
          id: { in: [...new Set(rows.map((r) => r.classId))] },
          ...(isDean ? classDeanWhere(departmentIds) : {}),
        },
        select: { id: true },
      })
    ).map((c) => c.id)
  );
  const scopedRows = rows.filter((r) => inScopeClassIds.has(r.classId));

  // Re-check for conflicts right before writing — time may have passed
  // since preview (see CLAUDE.md's P2002-in-a-loop convention: never catch
  // this mid-transaction, filter out beforehand).
  const existing = await prisma.lecturerCourseAssignment.findMany({
    where: {
      OR: scopedRows.map((r) => ({ classId: r.classId, courseId: r.courseId, semesterId: r.semesterId })),
    },
    select: { classId: true, courseId: true, semesterId: true },
  });
  const existingKeys = new Set(existing.map((a) => `${a.classId}:${a.courseId}:${a.semesterId}`));
  const seen = new Set<string>();
  const toCreate: WorkloadImportRow[] = [];
  for (const row of scopedRows) {
    const key = `${row.classId}:${row.courseId}:${row.semesterId}`;
    if (existingKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    toCreate.push(row);
  }

  const autoEnrolled: AutoEnrolledRecord[] = [];
  const createdAssignments: CreatedAssignmentSummary[] = [];

  if (toCreate.length > 0) {
    await prisma.$transaction(async (tx) => {
      for (const row of toCreate) {
        const assignment = await tx.lecturerCourseAssignment.create({
          data: {
            lecturerId: row.lecturerId,
            courseId: row.courseId,
            classId: row.classId,
            semesterId: row.semesterId,
            creditHours: row.creditHours,
          },
        });
        createdAssignments.push({
          assignmentId: assignment.id,
          lecturerName: row.lecturerName,
          courseName: row.courseName,
          className: row.className,
          classId: row.classId,
          semesterId: row.semesterId,
          semesterLabel: row.semesterLabel,
          classCurrentSemesterNumber: row.classCurrentSemesterNumber,
          studyMode: row.studyMode,
          creditHours: row.creditHours,
        });
        const enrolled = await autoEnrollClassIntoAssignment(tx, assignment);
        autoEnrolled.push(...enrolled);
      }
    }, BULK_TRANSACTION_OPTIONS);
  }

  await audit({
    userId: admin.id,
    action: "WORKLOAD_IMPORTED",
    entity: "LecturerCourseAssignment",
    newValue: {
      fileName,
      requested: rows.length,
      created: toCreate.length,
      skipped: rows.length - toCreate.length,
    },
  });
  await auditAutoEnrollments(admin.id, autoEnrolled);

  revalidatePath("/admin/curriculum");
  revalidatePath("/admin/students");
  revalidatePath("/admin/workload-import");

  return {
    created: toCreate.length,
    skipped: rows.length - toCreate.length,
    errorsInFile,
    createdAssignments,
  };
}
