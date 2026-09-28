import * as XLSX from "xlsx";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { decryptCredential, encryptCredential } from "@/lib/credential-crypto";
import { formatClassLabel } from "@/lib/class-label";
import {
  DriveReconnectError,
  createBackupFolder,
  createFile,
  driveConfigured,
  isFolderUsable,
  refreshAccessToken,
  updateFileContent,
} from "@/lib/google-drive";

// Lecturer Google Drive backup of the lecturer's OWN CA marks — see
// CLAUDE.md "Lecturer Google Drive backup". One workbook, one sheet per
// course, DRAFT + PUBLISHED marks (this is the lecturer's own working copy,
// not a student-facing view). Two triggers funnel into runDriveBackup:
//   - debounced: every result/assessment change pushes backupDueAt to
//     now + 5 min (scheduleDriveBackupForUser), so a burst of edits is one
//     upload;
//   - daily safety net: runDueDriveBackups marks any connection not
//     attempted in 24h as due.
// Both are driven by the in-process scheduler started from
// instrumentation.ts. Nothing here ever throws into a lecturer's action.

export const BACKUP_DEBOUNCE_MS = 5 * 60 * 1000;
export const DAILY_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const SCHEDULER_TICK_MS = 60 * 1000;
export const BACKUP_FILE_NAME = "SAMS Marks Backup.xlsx";
const MAX_BACKUPS_PER_TICK = 20;
export const RECONNECT_MESSAGE =
  "Google Drive access was revoked or has expired — reconnect Google Drive.";

// ---------------------------------------------------------------- triggers

// Debounced trigger — called (fire-and-forget) after a lecturer changes
// any of their own results/assessments. A single UPDATE keyed by the
// session user; a no-op (zero rows) for a lecturer without a connection.
// Never throws, never awaits anything slow.
export async function scheduleDriveBackupForUser(userId: string): Promise<void> {
  try {
    await prisma.lecturerGoogleDriveConnection.updateMany({
      where: { lecturer: { userId }, needsReconnect: false },
      data: {
        backupDueAt: new Date(Date.now() + BACKUP_DEBOUNCE_MS),
        lastBackupStatus: "PENDING",
      },
    });
  } catch (error) {
    console.error("[drive-backup] schedule failed", error);
  }
}

// ---------------------------------------------------------------- workbook

export interface BackupAssessment {
  id: string;
  title: string;
  results: {
    enrollmentId: string;
    mark: number | null;
    attendanceStatus: "PRESENT" | "ABSENT" | "EXEMPT";
  }[];
}

export interface BackupAssignment {
  courseId: string;
  courseCode: string;
  courseName: string;
  classLabel: string;
  programName: string;
  assessments: BackupAssessment[];
  students: { enrollmentId: string; studentNo: string; fullName: string }[];
}

export interface BackupSheet {
  name: string;
  rows: (string | number | null)[][];
}

function sanitizeSheetName(raw: string, used: Set<string>): string {
  const base = raw.replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 31) || "Sheet";
  let name = base;
  for (let n = 2; used.has(name.toLowerCase()); n++) {
    const suffix = ` (${n})`;
    name = `${base.slice(0, 31 - suffix.length)}${suffix}`;
  }
  used.add(name.toLowerCase());
  return name;
}

function markCell(
  result: BackupAssessment["results"][number] | undefined
): string | number | null {
  if (!result) return null;
  if (result.mark !== null) return result.mark;
  if (result.attendanceStatus === "ABSENT") return "Absent";
  if (result.attendanceStatus === "EXEMPT") return "Exempt";
  return null;
}

// Pure: one sheet per COURSE. Assessment columns are the union of titles
// across that course's classes (so "Quiz 1" in two classes shares a
// column); a title repeated within ONE class gets " (2)", " (3)"… so no
// two of that class's assessments ever collapse into one column.
export function buildBackupSheets(assignments: BackupAssignment[]): BackupSheet[] {
  const byCourse = new Map<string, BackupAssignment[]>();
  for (const a of assignments) {
    const list = byCourse.get(a.courseId) ?? [];
    list.push(a);
    byCourse.set(a.courseId, list);
  }

  const courses = [...byCourse.values()].sort((x, y) =>
    x[0].courseCode.localeCompare(y[0].courseCode)
  );
  const usedNames = new Set<string>();
  const sheets: BackupSheet[] = [];

  for (const courseAssignments of courses) {
    const columns: string[] = [];
    const perAssignment = courseAssignments.map((a) => {
      const seen = new Map<string, number>();
      const assessmentColumns = a.assessments.map((as) => {
        const count = (seen.get(as.title) ?? 0) + 1;
        seen.set(as.title, count);
        const column = count === 1 ? as.title : `${as.title} (${count})`;
        if (!columns.includes(column)) columns.push(column);
        return { column, assessment: as };
      });
      return { assignment: a, assessmentColumns };
    });

    const body: { sortKey: string; row: (string | number | null)[] }[] = [];
    for (const { assignment, assessmentColumns } of perAssignment) {
      for (const student of assignment.students) {
        const row: (string | number | null)[] = [
          student.studentNo,
          student.fullName,
          assignment.classLabel,
          assignment.programName,
        ];
        for (const column of columns) {
          const match = assessmentColumns.find((c) => c.column === column);
          row.push(
            match
              ? markCell(
                  match.assessment.results.find(
                    (r) => r.enrollmentId === student.enrollmentId
                  )
                )
              : null
          );
        }
        body.push({ sortKey: `${assignment.classLabel}\u0000${student.studentNo}`, row });
      }
    }
    body.sort((x, y) => x.sortKey.localeCompare(y.sortKey));

    const first = courseAssignments[0];
    sheets.push({
      name: sanitizeSheetName(`${first.courseCode} ${first.courseName}`, usedNames),
      rows: [["ID", "Name", "Class", "Program", ...columns], ...body.map((b) => b.row)],
    });
  }
  return sheets;
}

// Only the lecturer's OWN assignments (lecturerId = this lecturer — the
// same "current owner" every My Courses/marks-grid query uses), active
// semester only, ACTIVE enrollments (exactly the marks grid's roster).
export async function loadBackupAssignments(
  lecturerId: string
): Promise<{ semesterName: string | null; assignments: BackupAssignment[] }> {
  const rows = await prisma.lecturerCourseAssignment.findMany({
    where: { lecturerId, semester: { isActive: true } },
    include: {
      course: true,
      class: { include: { program: true } },
      semester: { include: { academicYear: true } },
      assessments: {
        where: { deletedAt: null },
        orderBy: { createdAt: "asc" },
        include: {
          results: {
            select: { enrollmentId: true, mark: true, attendanceStatus: true },
          },
        },
      },
    },
  });
  if (rows.length === 0) return { semesterName: null, assignments: [] };

  const enrollments = await prisma.studentCourseEnrollment.findMany({
    where: {
      status: "ACTIVE",
      OR: rows.map((r) => ({
        courseId: r.courseId,
        classId: r.classId,
        semesterId: r.semesterId,
      })),
    },
    include: { student: { select: { studentNo: true, fullName: true } } },
  });

  const semester = rows[0].semester;
  return {
    semesterName: `${semester.academicYear.name} — ${semester.name}`,
    assignments: rows.map((r) => ({
      courseId: r.courseId,
      courseCode: r.course.code,
      courseName: r.course.name,
      classLabel: formatClassLabel(r.class),
      programName: r.class.program.name,
      assessments: r.assessments.map((as) => ({
        id: as.id,
        title: as.title,
        results: as.results.map((res) => ({
          enrollmentId: res.enrollmentId,
          mark: res.mark === null ? null : Number(res.mark),
          attendanceStatus: res.attendanceStatus,
        })),
      })),
      students: enrollments
        .filter(
          (e) =>
            e.courseId === r.courseId &&
            e.classId === r.classId &&
            e.semesterId === r.semesterId
        )
        .map((e) => ({
          enrollmentId: e.id,
          studentNo: e.student.studentNo,
          fullName: e.student.fullName,
        })),
    })),
  };
}

export function buildBackupWorkbook(params: {
  lecturerName: string;
  semesterName: string | null;
  sheets: BackupSheet[];
  generatedAt: Date;
}): Buffer {
  const wb = XLSX.utils.book_new();
  const info = XLSX.utils.aoa_to_sheet([
    ["SAMS marks backup"],
    ["Lecturer", params.lecturerName],
    ["Semester", params.semesterName ?? "No active semester"],
    ["Generated (UTC)", params.generatedAt.toISOString().replace("T", " ").slice(0, 19)],
    [],
    ["Includes both DRAFT and PUBLISHED marks — your own working copy."],
    ["Blank cell = no result entered yet."],
  ]);
  XLSX.utils.book_append_sheet(wb, info, "Info");
  for (const sheet of params.sheets) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet.rows), sheet.name);
  }
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

// ---------------------------------------------------------------- backup

export type DriveBackupOutcome = "SUCCESS" | "FAILED" | "NEEDS_RECONNECT" | "SKIPPED";

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.slice(0, 500);
}

// THE one backup function — both triggers call it. Never throws.
export async function runDriveBackup(connectionId: string): Promise<DriveBackupOutcome> {
  const connection = await prisma.lecturerGoogleDriveConnection
    .findUnique({
      where: { id: connectionId },
      include: { lecturer: { select: { id: true, fullName: true, userId: true } } },
    })
    .catch(() => null);
  if (!connection || connection.needsReconnect) return "SKIPPED";

  const now = new Date();
  try {
    const refreshToken = decryptCredential(connection.refreshTokenEncrypted);
    if (!refreshToken) throw new DriveReconnectError("Stored Google credential could not be read.");

    const accessToken = await refreshAccessToken(refreshToken);

    let folderId = connection.driveFolderId;
    if (!folderId || !(await isFolderUsable(accessToken, folderId))) {
      folderId = await createBackupFolder(accessToken);
    }

    const { semesterName, assignments } = await loadBackupAssignments(connection.lecturerId);
    const content = buildBackupWorkbook({
      lecturerName: connection.lecturer.fullName,
      semesterName,
      sheets: buildBackupSheets(assignments),
      generatedAt: now,
    });

    let fileId = connection.driveFileId;
    const updated =
      fileId !== null && folderId === connection.driveFolderId
        ? await updateFileContent(accessToken, fileId, content)
        : false;
    if (!updated) {
      fileId = await createFile(accessToken, {
        name: BACKUP_FILE_NAME,
        folderId,
        content,
      });
    }

    await prisma.lecturerGoogleDriveConnection.update({
      where: { id: connectionId },
      data: {
        accessTokenEncrypted:
          encryptCredential(accessToken) ?? connection.accessTokenEncrypted,
        driveFolderId: folderId,
        driveFileId: fileId,
        lastBackupAt: now,
        lastAttemptAt: now,
        lastBackupStatus: "SUCCESS",
        lastErrorMessage: null,
      },
    });
    return "SUCCESS";
  } catch (error) {
    const reconnect = error instanceof DriveReconnectError;
    const message = reconnect ? RECONNECT_MESSAGE : errorMessage(error);
    try {
      await prisma.lecturerGoogleDriveConnection.update({
        where: { id: connectionId },
        data: {
          lastAttemptAt: now,
          lastBackupStatus: "FAILED",
          lastErrorMessage: message,
          needsReconnect: reconnect ? true : undefined,
          backupDueAt: reconnect ? null : undefined,
        },
      });
      await audit({
        userId: connection.lecturer.userId,
        action: "GOOGLE_DRIVE_BACKUP_FAILED",
        entity: "Lecturer",
        entityId: connection.lecturerId,
        newValue: { error: message, needsReconnect: reconnect },
      });
    } catch (logError) {
      console.error("[drive-backup] could not record failure", logError);
    }
    return reconnect ? "NEEDS_RECONNECT" : "FAILED";
  }
}

// One scheduler tick: queue the daily safety net, then run everything due.
// Each due row is CLAIMED with a conditional update (backupDueAt must still
// equal what we read) so a row is never run twice, even if a new edit
// re-scheduled it meanwhile (that newer due time simply wins next tick).
export async function runDueDriveBackups(now: Date = new Date()): Promise<number> {
  await prisma.lecturerGoogleDriveConnection.updateMany({
    where: {
      needsReconnect: false,
      backupDueAt: null,
      OR: [
        { lastAttemptAt: null },
        { lastAttemptAt: { lt: new Date(now.getTime() - DAILY_BACKUP_INTERVAL_MS) } },
      ],
    },
    data: { backupDueAt: now },
  });

  const due = await prisma.lecturerGoogleDriveConnection.findMany({
    where: { needsReconnect: false, backupDueAt: { lte: now } },
    select: { id: true, backupDueAt: true },
    orderBy: { backupDueAt: "asc" },
    take: MAX_BACKUPS_PER_TICK,
  });

  let ran = 0;
  for (const row of due) {
    const claimed = await prisma.lecturerGoogleDriveConnection.updateMany({
      where: { id: row.id, backupDueAt: row.backupDueAt },
      data: { backupDueAt: null },
    });
    if (claimed.count !== 1) continue;
    await runDriveBackup(row.id);
    ran++;
  }
  return ran;
}

// ---------------------------------------------------------------- scheduler

const globalForScheduler = globalThis as unknown as {
  samsDriveBackupTimer?: ReturnType<typeof setInterval>;
};

// Started once per server process from instrumentation.ts. Single app
// container in production (docker-compose), and the claim above keeps it
// correct even if that ever changes.
export function startDriveBackupScheduler(): void {
  if (globalForScheduler.samsDriveBackupTimer) return;
  if (!driveConfigured()) return;

  let inFlight = false;
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      await runDueDriveBackups();
    } catch (error) {
      console.error("[drive-backup] tick failed", error);
    } finally {
      inFlight = false;
    }
  };
  const timer = setInterval(() => void tick(), SCHEDULER_TICK_MS);
  timer.unref?.();
  globalForScheduler.samsDriveBackupTimer = timer;
}
