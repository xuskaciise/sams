import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAdmin = { id: "admin-1" };

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/import/parse", () => ({
  parseSpreadsheet: vi.fn(),
  assertFileSize: vi.fn(),
  assertRowCount: vi.fn(),
}));

vi.mock("argon2", () => ({
  default: { hash: vi.fn().mockResolvedValue("hashed"), argon2id: "argon2id" },
}));

function makeTx() {
  return {
    user: { create: vi.fn() },
    lecturer: { create: vi.fn() },
  };
}

let tx = makeTx();

vi.mock("@/lib/db", () => ({
  prisma: {
    role: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "role-lecturer", name: "LECTURER" }),
    },
    lecturer: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
  },
}));

import { requirePermission } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { parseSpreadsheet } from "@/lib/import/parse";
import {
  previewLecturerImport,
  confirmLecturerImport,
} from "./bulk-import-actions";

function fileFormData(): FormData {
  const fd = new FormData();
  fd.set("file", new File(["dummy"], "lecturers.xlsx"));
  return fd;
}

function row(rowNumber: number, cells: Record<string, string>) {
  return { rowNumber, cells };
}

describe("previewLecturerImport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockAdmin as never);
    vi.mocked(prisma.lecturer.findMany).mockResolvedValue([]);
    vi.mocked(prisma.user.findMany).mockResolvedValue([]);
  });

  it("marks a valid row as OK", async () => {
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [
        row(1, {
          staff_no: "L001",
          full_name: "Dr. Amina Yusuf",
          email: "amina@university.edu",
        }),
      ],
    });

    const result = await previewLecturerImport(fileFormData());

    expect(result.rows[0]).toMatchObject({
      status: "OK",
      data: {
        staffNo: "L001",
        fullName: "Dr. Amina Yusuf",
        email: "amina@university.edu",
      },
    });
  });

  it("flags an invalid email", async () => {
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [row(1, { staff_no: "L001", full_name: "Dr. Amina Yusuf", email: "not-an-email" })],
    });

    const result = await previewLecturerImport(fileFormData());

    expect(result.rows[0].status).toBe("ERROR");
    expect(result.rows[0].reason).toContain("Invalid email");
  });

  it("flags duplicate staff_no across rows in the same file", async () => {
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [
        row(1, { staff_no: "L001", full_name: "A", email: "a@university.edu" }),
        row(2, { staff_no: "L001", full_name: "B", email: "b@university.edu" }),
      ],
    });

    const result = await previewLecturerImport(fileFormData());

    expect(result.rows[0].status).toBe("DUPLICATE_IN_FILE");
    expect(result.rows[1].status).toBe("DUPLICATE_IN_FILE");
  });

  it("flags duplicate email across rows even with different staff_no", async () => {
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [
        row(1, { staff_no: "L001", full_name: "A", email: "same@university.edu" }),
        row(2, { staff_no: "L002", full_name: "B", email: "same@university.edu" }),
      ],
    });

    const result = await previewLecturerImport(fileFormData());

    expect(result.rows[0].status).toBe("DUPLICATE_IN_FILE");
    expect(result.rows[1].status).toBe("DUPLICATE_IN_FILE");
  });

  it("flags a staff_no or email that already exists in the DB as ALREADY_EXISTS", async () => {
    vi.mocked(prisma.lecturer.findMany).mockResolvedValue([
      { staffNo: "L001" },
    ] as never);
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [row(1, { staff_no: "L001", full_name: "A", email: "a@university.edu" })],
    });

    const result = await previewLecturerImport(fileFormData());

    expect(result.rows[0].status).toBe("ALREADY_EXISTS");
  });
});

describe("confirmLecturerImport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tx = makeTx();
    vi.mocked(prisma.$transaction).mockImplementation(async (fn) =>
      (fn as (tx: unknown) => unknown)(tx)
    );
    vi.mocked(requirePermission).mockResolvedValue(mockAdmin as never);
    vi.mocked(prisma.lecturer.findMany).mockResolvedValue([]);
    vi.mocked(prisma.user.findMany).mockResolvedValue([]);
  });

  it("does nothing for an empty row list", async () => {
    const result = await confirmLecturerImport([], "lecturers.xlsx");

    expect(result).toEqual({ created: [] });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("pre-checks staff_no and email conflicts and only creates the rest", async () => {
    vi.mocked(prisma.lecturer.findMany).mockResolvedValue([
      { staffNo: "L001" },
    ] as never);
    vi.mocked(tx.user.create).mockResolvedValue({ id: "user-2" } as never);
    vi.mocked(tx.lecturer.create).mockResolvedValue({} as never);

    const result = await confirmLecturerImport(
      [
        { staffNo: "L001", fullName: "A", email: "a@university.edu" },
        { staffNo: "L002", fullName: "B", email: "b@university.edu" },
      ],
      "lecturers.xlsx"
    );

    expect(tx.user.create).toHaveBeenCalledTimes(1);
    expect(tx.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          username: "b@university.edu",
          email: "b@university.edu",
          userRoles: { create: { roleId: "role-lecturer" } },
          mustChangePw: true,
        }),
      })
    );
    expect(tx.lecturer.create).toHaveBeenCalledWith({
      data: { userId: "user-2", staffNo: "L002", title: null },
    });
    expect(result.created).toHaveLength(1);
    expect(result.created[0]).toMatchObject({ staffNo: "L002", email: "b@university.edu" });
    expect(result.created[0].tempPassword).toBeTruthy();
  });

  it("audits BULK_IMPORT once and USER_CREATED per created lecturer", async () => {
    vi.mocked(tx.user.create).mockResolvedValue({ id: "user-1" } as never);
    vi.mocked(tx.lecturer.create).mockResolvedValue({} as never);

    await confirmLecturerImport(
      [{ staffNo: "L001", fullName: "A", email: "a@university.edu" }],
      "lecturers.xlsx"
    );

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "admin-1",
        action: "BULK_IMPORT",
        entity: "User",
        newValue: expect.objectContaining({
          entityType: "Lecturer",
          fileName: "lecturers.xlsx",
          created: 1,
        }),
      })
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "admin-1",
        action: "USER_CREATED",
        entity: "User",
        entityId: "user-1",
      })
    );
  });
});
