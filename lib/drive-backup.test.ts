import { describe, it, expect, vi, beforeEach } from "vitest";
import * as XLSX from "xlsx";

vi.mock("@/lib/db", () => ({
  prisma: {
    lecturerGoogleDriveConnection: {
      updateMany: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    lecturerCourseAssignment: { findMany: vi.fn() },
    studentCourseEnrollment: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/credential-crypto", () => ({
  decryptCredential: vi.fn((v: string) => (v.startsWith("enc:") ? v.slice(4) : null)),
  encryptCredential: vi.fn((v: string) => `enc:${v}`),
}));
vi.mock("@/lib/google-drive", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/google-drive")>();
  return {
    DriveReconnectError: actual.DriveReconnectError,
    driveConfigured: vi.fn(() => true),
    refreshAccessToken: vi.fn(),
    isFolderUsable: vi.fn(),
    createBackupFolder: vi.fn(),
    updateFileContent: vi.fn(),
    createFile: vi.fn(),
  };
});

import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import * as drive from "@/lib/google-drive";
import {
  BACKUP_DEBOUNCE_MS,
  RECONNECT_MESSAGE,
  buildBackupSheets,
  buildBackupWorkbook,
  loadBackupAssignments,
  runDriveBackup,
  runDueDriveBackups,
  scheduleDriveBackupForUser,
  type BackupAssignment,
} from "./drive-backup";

const conn = prisma.lecturerGoogleDriveConnection;

function assignment(overrides: Partial<BackupAssignment> = {}): BackupAssignment {
  return {
    courseId: "c1",
    courseCode: "CS101",
    courseName: "Databases",
    classLabel: "CMS26-A-FT (Semester 3)",
    programName: "Computer Science",
    assessments: [
      {
        id: "as1",
        title: "Quiz 1",
        results: [
          { enrollmentId: "e1", mark: 8.5, attendanceStatus: "PRESENT" },
          { enrollmentId: "e2", mark: null, attendanceStatus: "ABSENT" },
        ],
      },
      { id: "as2", title: "Midterm", results: [{ enrollmentId: "e1", mark: 20, attendanceStatus: "PRESENT" }] },
    ],
    students: [
      { enrollmentId: "e2", studentNo: "S002", fullName: "Bilan" },
      { enrollmentId: "e1", studentNo: "S001", fullName: "Ahmed" },
      { enrollmentId: "e3", studentNo: "S003", fullName: "Cali" },
    ],
    ...overrides,
  };
}

describe("buildBackupSheets", () => {
  it("builds ID | Name | Class | Program | one column per assessment, blank when no result", () => {
    const [sheet] = buildBackupSheets([assignment()]);
    expect(sheet.name).toBe("CS101 Databases");
    expect(sheet.rows).toEqual([
      ["ID", "Name", "Class", "Program", "Quiz 1", "Midterm"],
      ["S001", "Ahmed", "CMS26-A-FT (Semester 3)", "Computer Science", 8.5, 20],
      ["S002", "Bilan", "CMS26-A-FT (Semester 3)", "Computer Science", "Absent", null],
      ["S003", "Cali", "CMS26-A-FT (Semester 3)", "Computer Science", null, null],
    ]);
  });

  it("puts every class of the same course on ONE sheet with a shared column set", () => {
    const sheets = buildBackupSheets([
      assignment(),
      assignment({
        classLabel: "CMS26-B-FT (Semester 3)",
        assessments: [
          { id: "b1", title: "Quiz 1", results: [{ enrollmentId: "f1", mark: 5, attendanceStatus: "PRESENT" }] },
          { id: "b2", title: "Lab 1", results: [] },
        ],
        students: [{ enrollmentId: "f1", studentNo: "S100", fullName: "Deeqa" }],
      }),
      assignment({ courseId: "c2", courseCode: "CS102", courseName: "Networks", assessments: [], students: [] }),
    ]);
    expect(sheets.map((s) => s.name)).toEqual(["CS101 Databases", "CS102 Networks"]);
    expect(sheets[0].rows[0]).toEqual(["ID", "Name", "Class", "Program", "Quiz 1", "Midterm", "Lab 1"]);
    expect(sheets[0].rows.at(-1)).toEqual([
      "S100", "Deeqa", "CMS26-B-FT (Semester 3)", "Computer Science", 5, null, null,
    ]);
  });

  it("never collapses two same-titled assessments of one class into one column", () => {
    const [sheet] = buildBackupSheets([
      assignment({
        assessments: [
          { id: "a", title: "Quiz", results: [{ enrollmentId: "e1", mark: 1, attendanceStatus: "PRESENT" }] },
          { id: "b", title: "Quiz", results: [{ enrollmentId: "e1", mark: 2, attendanceStatus: "PRESENT" }] },
        ],
        students: [{ enrollmentId: "e1", studentNo: "S001", fullName: "Ahmed" }],
      }),
    ]);
    expect(sheet.rows).toEqual([
      ["ID", "Name", "Class", "Program", "Quiz", "Quiz (2)"],
      ["S001", "Ahmed", "CMS26-A-FT (Semester 3)", "Computer Science", 1, 2],
    ]);
  });

  it("round-trips through a real xlsx workbook with an Info sheet first", () => {
    const buffer = buildBackupWorkbook({
      lecturerName: "Dr. X",
      semesterName: "2026-2027 — Semester 1",
      sheets: buildBackupSheets([assignment()]),
      generatedAt: new Date("2026-09-29T10:00:00Z"),
    });
    const wb = XLSX.read(buffer, { type: "buffer" });
    expect(wb.SheetNames).toEqual(["Info", "CS101 Databases"]);
    const rows = XLSX.utils.sheet_to_json(wb.Sheets["CS101 Databases"], { header: 1 });
    expect(rows[1]).toEqual(["S001", "Ahmed", "CMS26-A-FT (Semester 3)", "Computer Science", 8.5, 20]);
  });
});

describe("loadBackupAssignments", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads ONLY this lecturer's own active-semester assignments, drafts included (no status filter)", async () => {
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([]);
    const result = await loadBackupAssignments("lec-1");
    expect(result.assignments).toEqual([]);
    const args = vi.mocked(prisma.lecturerCourseAssignment.findMany).mock.calls[0][0]!;
    expect(args.where).toEqual({ lecturerId: "lec-1", semester: { isActive: true } });
    const include = args.include as { assessments: { where: unknown; include: { results: unknown } } };
    expect(include.assessments.where).toEqual({ deletedAt: null });
    // No `where: { status }` on results — DRAFT and PUBLISHED both included.
    expect(include.assessments.include.results).toEqual({
      select: { enrollmentId: true, mark: true, attendanceStatus: true },
    });
    expect(prisma.studentCourseEnrollment.findMany).not.toHaveBeenCalled();
  });
});

describe("scheduleDriveBackupForUser", () => {
  beforeEach(() => vi.clearAllMocks());

  it("pushes backupDueAt 5 minutes out for the session user's own connection", async () => {
    const before = Date.now();
    vi.mocked(conn.updateMany).mockResolvedValue({ count: 1 });
    await scheduleDriveBackupForUser("user-1");
    const args = vi.mocked(conn.updateMany).mock.calls[0][0]!;
    expect(args.where).toEqual({ lecturer: { userId: "user-1" }, needsReconnect: false });
    const due = (args.data as { backupDueAt: Date }).backupDueAt.getTime();
    expect(due).toBeGreaterThanOrEqual(before + BACKUP_DEBOUNCE_MS);
  });

  it("never throws, even when the DB fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(conn.updateMany).mockRejectedValue(new Error("db down"));
    await expect(scheduleDriveBackupForUser("user-1")).resolves.toBeUndefined();
  });
});

describe("runDriveBackup", () => {
  const baseConnection = {
    id: "conn-1",
    lecturerId: "lec-1",
    accessTokenEncrypted: "enc:old-access",
    refreshTokenEncrypted: "enc:refresh",
    driveFileId: "file-1" as string | null,
    driveFolderId: "folder-1" as string | null,
    needsReconnect: false,
    lecturer: { id: "lec-1", fullName: "Dr. X", userId: "user-1" },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(conn.findUnique).mockResolvedValue(baseConnection as never);
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([]);
    vi.mocked(drive.refreshAccessToken).mockResolvedValue("new-access");
    vi.mocked(drive.isFolderUsable).mockResolvedValue(true);
    vi.mocked(drive.updateFileContent).mockResolvedValue(true);
  });

  it("updates the existing file in place and records SUCCESS without auditing", async () => {
    expect(await runDriveBackup("conn-1")).toBe("SUCCESS");
    expect(drive.updateFileContent).toHaveBeenCalledWith("new-access", "file-1", expect.any(Buffer));
    expect(drive.createFile).not.toHaveBeenCalled();
    const data = vi.mocked(conn.update).mock.calls[0][0].data as Record<string, unknown>;
    expect(data).toMatchObject({
      lastBackupStatus: "SUCCESS",
      lastErrorMessage: null,
      driveFileId: "file-1",
      accessTokenEncrypted: "enc:new-access",
    });
    expect(data.lastBackupAt).toBeInstanceOf(Date);
    expect(audit).not.toHaveBeenCalled();
  });

  it("creates the file in the backup folder when there's no driveFileId yet", async () => {
    vi.mocked(conn.findUnique).mockResolvedValue({ ...baseConnection, driveFileId: null } as never);
    vi.mocked(drive.createFile).mockResolvedValue("file-new");
    await runDriveBackup("conn-1");
    expect(drive.createFile).toHaveBeenCalledWith("new-access", expect.objectContaining({ folderId: "folder-1" }));
    expect(vi.mocked(conn.update).mock.calls[0][0].data).toMatchObject({ driveFileId: "file-new" });
  });

  it("creates a new file when the stored one was deleted from Drive", async () => {
    vi.mocked(drive.updateFileContent).mockResolvedValue(false);
    vi.mocked(drive.createFile).mockResolvedValue("file-2");
    await runDriveBackup("conn-1");
    expect(vi.mocked(conn.update).mock.calls[0][0].data).toMatchObject({ driveFileId: "file-2" });
  });

  it("recreates the folder (and file) when the folder is gone", async () => {
    vi.mocked(drive.isFolderUsable).mockResolvedValue(false);
    vi.mocked(drive.createBackupFolder).mockResolvedValue("folder-2");
    vi.mocked(drive.createFile).mockResolvedValue("file-3");
    await runDriveBackup("conn-1");
    expect(drive.updateFileContent).not.toHaveBeenCalled();
    expect(vi.mocked(conn.update).mock.calls[0][0].data).toMatchObject({
      driveFolderId: "folder-2",
      driveFileId: "file-3",
    });
  });

  it("marks the connection as needing reconnect on a revoked refresh token — and audits it", async () => {
    vi.mocked(drive.refreshAccessToken).mockRejectedValue(new drive.DriveReconnectError());
    expect(await runDriveBackup("conn-1")).toBe("NEEDS_RECONNECT");
    expect(vi.mocked(conn.update).mock.calls[0][0].data).toMatchObject({
      lastBackupStatus: "FAILED",
      lastErrorMessage: RECONNECT_MESSAGE,
      needsReconnect: true,
      backupDueAt: null,
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "GOOGLE_DRIVE_BACKUP_FAILED", userId: "user-1" })
    );
  });

  it("records a generic FAILED (not reconnect) for any other error, and never throws", async () => {
    vi.mocked(drive.updateFileContent).mockRejectedValue(new Error("Google API 500"));
    expect(await runDriveBackup("conn-1")).toBe("FAILED");
    const data = vi.mocked(conn.update).mock.calls[0][0].data as Record<string, unknown>;
    expect(data).toMatchObject({ lastBackupStatus: "FAILED", lastErrorMessage: "Google API 500" });
    expect(data.needsReconnect).toBeUndefined();
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it("skips a connection already flagged needsReconnect", async () => {
    vi.mocked(conn.findUnique).mockResolvedValue({ ...baseConnection, needsReconnect: true } as never);
    expect(await runDriveBackup("conn-1")).toBe("SKIPPED");
    expect(drive.refreshAccessToken).not.toHaveBeenCalled();
  });
});

describe("runDueDriveBackups", () => {
  beforeEach(() => vi.clearAllMocks());

  it("queues the daily safety net, then runs only the rows it successfully claims", async () => {
    const now = new Date("2026-09-29T12:00:00Z");
    vi.mocked(conn.updateMany)
      .mockResolvedValueOnce({ count: 0 }) // daily queue
      .mockResolvedValueOnce({ count: 1 }) // claim a
      .mockResolvedValueOnce({ count: 0 }); // b re-scheduled meanwhile
    vi.mocked(conn.findMany).mockResolvedValue([
      { id: "a", backupDueAt: now },
      { id: "b", backupDueAt: now },
    ] as never);
    vi.mocked(conn.findUnique).mockResolvedValue(null);

    expect(await runDueDriveBackups(now)).toBe(1);

    const daily = vi.mocked(conn.updateMany).mock.calls[0][0]!;
    expect(daily.where).toEqual({
      needsReconnect: false,
      backupDueAt: null,
      OR: [
        { lastAttemptAt: null },
        { lastAttemptAt: { lt: new Date("2026-09-28T12:00:00Z") } },
      ],
    });
    expect(vi.mocked(conn.updateMany).mock.calls[1][0]).toEqual({
      where: { id: "a", backupDueAt: now },
      data: { backupDueAt: null },
    });
    expect(conn.findUnique).toHaveBeenCalledTimes(1);
  });
});
