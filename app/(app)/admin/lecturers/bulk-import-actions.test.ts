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

function makeTx() {
  return {
    lecturer: { create: vi.fn() },
  };
}

let tx = makeTx();

vi.mock("@/lib/db", () => ({
  prisma: {
    lecturer: { findMany: vi.fn() },
    department: { findMany: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
  },
  BULK_TRANSACTION_OPTIONS: { timeout: 30000, maxWait: 10000 },
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
    tx = makeTx();
    vi.mocked(requirePermission).mockResolvedValue(mockAdmin as never);
    vi.mocked(prisma.lecturer.findMany).mockResolvedValue([]);
    vi.mocked(prisma.department.findMany).mockResolvedValue([
      { id: "dept-1", code: "CS", name: "Computer Science" },
    ] as never);
  });

  it("enforces user.manage before parsing anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(previewLecturerImport(fileFormData())).rejects.toThrow(
      "FORBIDDEN"
    );
    expect(parseSpreadsheet).not.toHaveBeenCalled();
  });

  it("marks a fully valid row as OK, resolving department by code", async () => {
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [
        row(1, {
          staff_no: "L001",
          full_name: "Dr. Amina Yusuf",
          phone_number: "+252611111111",
          department: "CS",
        }),
      ],
    } as never);

    const result = await previewLecturerImport(fileFormData());

    expect(result.counts).toEqual({ ok: 1, duplicate: 0, alreadyExists: 0, error: 0 });
    expect(result.rows[0].data).toEqual({
      staffNo: "L001",
      fullName: "Dr. Amina Yusuf",
      phoneNumber: "+252611111111",
      departmentId: "dept-1",
    });
  });

  it("leaves departmentId null when the column is blank — department is optional", async () => {
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [
        row(1, {
          staff_no: "L001",
          full_name: "Dr. Amina Yusuf",
          phone_number: "+252611111111",
          department: "",
        }),
      ],
    } as never);

    const result = await previewLecturerImport(fileFormData());

    expect(result.rows[0].status).toBe("OK");
    expect(result.rows[0].data?.departmentId).toBeNull();
  });

  it("flags an unknown department as an ERROR rather than silently dropping it", async () => {
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [
        row(1, {
          staff_no: "L001",
          full_name: "Dr. Amina Yusuf",
          phone_number: "+252611111111",
          department: "Nonexistent",
        }),
      ],
    } as never);

    const result = await previewLecturerImport(fileFormData());

    expect(result.rows[0].status).toBe("ERROR");
    expect(result.rows[0].reason).toContain("Unknown department");
  });

  it("flags a missing/invalid phone_number as an ERROR", async () => {
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [
        row(1, { staff_no: "L001", full_name: "Dr. Amina Yusuf", phone_number: "" }),
        row(2, { staff_no: "L002", full_name: "Dr. Omar Ali", phone_number: "not-a-phone" }),
      ],
    } as never);

    const result = await previewLecturerImport(fileFormData());

    expect(result.rows[0].status).toBe("ERROR");
    expect(result.rows[0].reason).toContain("Missing phone_number");
    expect(result.rows[1].status).toBe("ERROR");
    expect(result.rows[1].reason).toContain("Invalid phone_number");
  });

  it("flags every row sharing a duplicate staff_no OR phone_number within the file, not just the 2nd+", async () => {
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [
        row(1, { staff_no: "L001", full_name: "Dr. A", phone_number: "+252611111111" }),
        row(2, { staff_no: "L001", full_name: "Dr. B", phone_number: "+252622222222" }),
        row(3, { staff_no: "L003", full_name: "Dr. C", phone_number: "+252611111111" }),
      ],
    } as never);

    const result = await previewLecturerImport(fileFormData());

    expect(result.rows[0].status).toBe("DUPLICATE_IN_FILE"); // staff_no clash
    expect(result.rows[1].status).toBe("DUPLICATE_IN_FILE"); // staff_no clash
    expect(result.rows[2].status).toBe("DUPLICATE_IN_FILE"); // phone clash with row 1
  });

  it("marks a row ALREADY_EXISTS when either staff_no or phone_number is already in the DB", async () => {
    vi.mocked(prisma.lecturer.findMany).mockResolvedValue([
      { staffNo: "L001", phoneNumber: "+252699999999" },
    ] as never);
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [
        row(1, { staff_no: "L001", full_name: "Dr. A", phone_number: "+252611111111" }),
        row(2, { staff_no: "L002", full_name: "Dr. B", phone_number: "+252699999999" }),
      ],
    } as never);

    const result = await previewLecturerImport(fileFormData());

    expect(result.rows[0].status).toBe("ALREADY_EXISTS");
    expect(result.rows[1].status).toBe("ALREADY_EXISTS");
  });
});

describe("confirmLecturerImport", () => {
  const validRows = [
    {
      staffNo: "L001",
      fullName: "Dr. Amina Yusuf",
      phoneNumber: "+252611111111",
      departmentId: "dept-1",
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    tx = makeTx();
    vi.mocked(requirePermission).mockResolvedValue(mockAdmin as never);
    vi.mocked(prisma.lecturer.findMany).mockResolvedValue([]);
  });

  it("enforces user.manage before writing anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(
      confirmLecturerImport(validRows, "lecturers.xlsx")
    ).rejects.toThrow("FORBIDDEN");
    expect(tx.lecturer.create).not.toHaveBeenCalled();
  });

  it("creates only Lecturer rows — no User, no account", async () => {
    const result = await confirmLecturerImport(validRows, "lecturers.xlsx");

    expect(result.created).toBe(1);
    expect(tx.lecturer.create).toHaveBeenCalledWith({
      data: {
        staffNo: "L001",
        fullName: "Dr. Amina Yusuf",
        phoneNumber: "+252611111111",
        departmentId: "dept-1",
      },
    });
  });

  it("re-checks for conflicts immediately before writing, skipping rows that raced into existence", async () => {
    vi.mocked(prisma.lecturer.findMany).mockResolvedValue([
      { staffNo: "L001", phoneNumber: "+252611111111" },
    ] as never);

    const result = await confirmLecturerImport(validRows, "lecturers.xlsx");

    expect(result.created).toBe(0);
    expect(tx.lecturer.create).not.toHaveBeenCalled();
  });

  it("audits BULK_IMPORT with entity Lecturer and requested/created/skipped counts", async () => {
    await confirmLecturerImport(validRows, "lecturers.xlsx");

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "BULK_IMPORT",
        entity: "Lecturer",
        newValue: expect.objectContaining({
          entityType: "Lecturer",
          fileName: "lecturers.xlsx",
          requested: 1,
          created: 1,
          skipped: 0,
        }),
      })
    );
  });
});
