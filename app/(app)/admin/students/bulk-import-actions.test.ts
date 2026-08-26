import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAdmin = { id: "admin-1" };

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
}));

vi.mock("@/lib/enrollment", () => ({
  autoEnrollStudentIntoClassCourses: vi.fn(),
  auditAutoEnrollments: vi.fn(),
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
    student: { create: vi.fn() },
  };
}

let tx = makeTx();

vi.mock("@/lib/db", () => ({
  prisma: {
    class: { findMany: vi.fn() },
    student: { findMany: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
  },
  BULK_TRANSACTION_OPTIONS: { timeout: 30000, maxWait: 10000 },
}));

import { requirePermission } from "@/lib/auth";
import { audit } from "@/lib/audit";
import {
  autoEnrollStudentIntoClassCourses,
  auditAutoEnrollments,
} from "@/lib/enrollment";
import { prisma } from "@/lib/db";
import { parseSpreadsheet } from "@/lib/import/parse";
import {
  previewStudentImport,
  confirmStudentImport,
} from "./bulk-import-actions";

function fileFormData(): FormData {
  const fd = new FormData();
  fd.set("file", new File(["dummy"], "students.xlsx"));
  return fd;
}

function row(rowNumber: number, cells: Record<string, string>) {
  return { rowNumber, cells };
}

describe("previewStudentImport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockAdmin as never);
    vi.mocked(prisma.class.findMany).mockResolvedValue([
      { id: "class-1", name: "CS-Year2-A", program: { code: "CS" } },
    ] as never);
    vi.mocked(prisma.student.findMany).mockResolvedValue([]);
  });

  it("enforces admin-only access before parsing anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(previewStudentImport(fileFormData())).rejects.toThrow(
      "FORBIDDEN"
    );
    expect(parseSpreadsheet).not.toHaveBeenCalled();
  });

  it("marks a fully valid row as OK and resolves class_code to a classId", async () => {
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [
        row(1, {
          student_no: "S1001",
          full_name: "Jane Doe",
          gender: "FEMALE",
          class_code: "CS-Year2-A",
        }),
      ],
    });

    const result = await previewStudentImport(fileFormData());

    expect(result.counts).toEqual({ ok: 1, duplicate: 0, alreadyExists: 0, error: 0 });
    expect(result.rows[0]).toMatchObject({
      status: "OK",
      data: {
        studentNo: "S1001",
        fullName: "Jane Doe",
        gender: "FEMALE",
        classId: "class-1",
        phoneNumber: null,
      },
    });
  });

  it("accepts a valid optional phone_number and resolves it onto the row", async () => {
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [
        row(1, {
          student_no: "S1001",
          full_name: "Jane Doe",
          gender: "FEMALE",
          class_code: "CS-Year2-A",
          phone_number: "+2526XXXXXXXX".replace(/X/g, "1"),
        }),
      ],
    });

    const result = await previewStudentImport(fileFormData());

    expect(result.rows[0].status).toBe("OK");
    expect(result.rows[0].data).toMatchObject({ phoneNumber: "+252611111111" });
  });

  it("accepts a digits-only phone_number with no leading '+' — the real-world data format", async () => {
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [
        row(1, {
          student_no: "S1001",
          full_name: "Jane Doe",
          gender: "FEMALE",
          class_code: "CS-Year2-A",
          phone_number: "252611111111",
        }),
      ],
    });

    const result = await previewStudentImport(fileFormData());

    expect(result.rows[0].status).toBe("OK");
    expect(result.rows[0].data).toMatchObject({ phoneNumber: "252611111111" });
  });

  it("still accepts a fully valid row with phone_number left blank — optional, not required", async () => {
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [
        row(1, {
          student_no: "S1001",
          full_name: "Jane Doe",
          gender: "FEMALE",
          class_code: "CS-Year2-A",
          phone_number: "",
        }),
      ],
    });

    const result = await previewStudentImport(fileFormData());

    expect(result.rows[0].status).toBe("OK");
    expect(result.rows[0].data).toMatchObject({ phoneNumber: null });
  });

  it("flags an invalid phone_number, but leaves it optional when blank", async () => {
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [
        row(1, {
          student_no: "S1001",
          full_name: "Jane Doe",
          gender: "FEMALE",
          class_code: "CS-Year2-A",
          phone_number: "not-a-phone",
        }),
      ],
    });

    const result = await previewStudentImport(fileFormData());

    expect(result.rows[0].status).toBe("ERROR");
    expect(result.rows[0].reason).toContain('Invalid phone_number "not-a-phone"');
  });

  it("flags missing fields with the exact reason", async () => {
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [row(1, { student_no: "", full_name: "", gender: "", class_code: "" })],
    });

    const result = await previewStudentImport(fileFormData());

    expect(result.rows[0].status).toBe("ERROR");
    expect(result.rows[0].reason).toContain("Missing student_no");
    expect(result.rows[0].reason).toContain("Missing full_name");
    expect(result.rows[0].reason).toContain("Missing gender");
    expect(result.rows[0].reason).toContain("Missing class_code");
  });

  it("flags an invalid gender", async () => {
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [
        row(1, {
          student_no: "S1001",
          full_name: "Jane Doe",
          gender: "OTHER",
          class_code: "CS-Year2-A",
        }),
      ],
    });

    const result = await previewStudentImport(fileFormData());

    expect(result.rows[0].status).toBe("ERROR");
    expect(result.rows[0].reason).toContain("Invalid gender");
  });

  it("flags an unknown class_code", async () => {
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [
        row(1, {
          student_no: "S1001",
          full_name: "Jane Doe",
          gender: "FEMALE",
          class_code: "NO-SUCH-CLASS",
        }),
      ],
    });

    const result = await previewStudentImport(fileFormData());

    expect(result.rows[0].status).toBe("ERROR");
    expect(result.rows[0].reason).toContain('Unknown class_code "NO-SUCH-CLASS"');
  });

  it("flags an ambiguous class_code that matches classes in more than one program", async () => {
    vi.mocked(prisma.class.findMany).mockResolvedValue([
      { id: "class-1", name: "Year2-A", program: { code: "CS" } },
      { id: "class-2", name: "Year2-A", program: { code: "IT" } },
    ] as never);
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [
        row(1, {
          student_no: "S1001",
          full_name: "Jane Doe",
          gender: "FEMALE",
          class_code: "Year2-A",
        }),
      ],
    });

    const result = await previewStudentImport(fileFormData());

    expect(result.rows[0].status).toBe("ERROR");
    expect(result.rows[0].reason).toContain("Ambiguous class_code");
    expect(result.rows[0].reason).toContain("CS");
    expect(result.rows[0].reason).toContain("IT");
  });

  it("flags every row sharing a duplicate student_no, not just the 2nd occurrence", async () => {
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [
        row(1, {
          student_no: "S1001",
          full_name: "Jane Doe",
          gender: "FEMALE",
          class_code: "CS-Year2-A",
        }),
        row(2, {
          student_no: "s1001",
          full_name: "Jane D.",
          gender: "FEMALE",
          class_code: "CS-Year2-A",
        }),
      ],
    });

    const result = await previewStudentImport(fileFormData());

    expect(result.rows[0].status).toBe("DUPLICATE_IN_FILE");
    expect(result.rows[1].status).toBe("DUPLICATE_IN_FILE");
    expect(result.counts.duplicate).toBe(2);
  });

  it("flags a student_no that already exists in the DB as ALREADY_EXISTS (skip, don't update)", async () => {
    vi.mocked(prisma.student.findMany).mockResolvedValue([
      { studentNo: "S1001" },
    ] as never);
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [
        row(1, {
          student_no: "S1001",
          full_name: "Jane Doe",
          gender: "FEMALE",
          class_code: "CS-Year2-A",
        }),
      ],
    });

    const result = await previewStudentImport(fileFormData());

    expect(result.rows[0].status).toBe("ALREADY_EXISTS");
    expect(result.counts.alreadyExists).toBe(1);
  });
});

describe("confirmStudentImport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tx = makeTx();
    vi.mocked(prisma.$transaction).mockImplementation(async (fn) =>
      (fn as (tx: unknown) => unknown)(tx)
    );
    vi.mocked(requirePermission).mockResolvedValue(mockAdmin as never);
    vi.mocked(prisma.student.findMany).mockResolvedValue([]);
    vi.mocked(autoEnrollStudentIntoClassCourses).mockResolvedValue([]);
  });

  it("does nothing for an empty row list", async () => {
    const result = await confirmStudentImport([], "students.xlsx");

    expect(result).toEqual({ created: 0 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("pre-checks for students that already exist and only creates the rest — never attempting a duplicate create", async () => {
    vi.mocked(prisma.student.findMany).mockResolvedValue([
      { studentNo: "S1001" },
    ] as never);
    vi.mocked(tx.student.create).mockResolvedValue({
      id: "student-2",
      classId: "class-1",
    } as never);

    const result = await confirmStudentImport(
      [
        { studentNo: "S1001", fullName: "Jane Doe", gender: "FEMALE", classId: "class-1", phoneNumber: null },
        { studentNo: "S1002", fullName: "John Roe", gender: "MALE", classId: "class-1", phoneNumber: "+252611111111" },
      ],
      "students.xlsx"
    );

    expect(tx.student.create).toHaveBeenCalledTimes(1);
    expect(tx.student.create).toHaveBeenCalledWith({
      data: {
        studentNo: "S1002",
        fullName: "John Roe",
        gender: "MALE",
        classId: "class-1",
        phoneNumber: "+252611111111",
      },
    });
    expect(result).toEqual({ created: 1 });
  });

  it("auto-enrolls every created student exactly as manual registration does", async () => {
    vi.mocked(tx.student.create).mockResolvedValue({
      id: "student-1",
      classId: "class-1",
    } as never);

    await confirmStudentImport(
      [{ studentNo: "S1001", fullName: "Jane Doe", gender: "FEMALE", classId: "class-1", phoneNumber: null }],
      "students.xlsx"
    );

    expect(autoEnrollStudentIntoClassCourses).toHaveBeenCalledWith(
      tx,
      "student-1",
      "class-1"
    );
  });

  it("audits BULK_IMPORT with the filename and row counts, and audits auto-enrollments after commit", async () => {
    vi.mocked(tx.student.create).mockResolvedValue({
      id: "student-1",
      classId: "class-1",
    } as never);
    vi.mocked(autoEnrollStudentIntoClassCourses).mockResolvedValue([
      { enrollmentId: "enr-1", studentId: "student-1", courseId: "c-1", semesterId: "sem-1" },
    ]);

    await confirmStudentImport(
      [{ studentNo: "S1001", fullName: "Jane Doe", gender: "FEMALE", classId: "class-1", phoneNumber: null }],
      "students.xlsx"
    );

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "admin-1",
        action: "BULK_IMPORT",
        entity: "Student",
        newValue: expect.objectContaining({
          entityType: "Student",
          fileName: "students.xlsx",
          created: 1,
        }),
      })
    );
    expect(auditAutoEnrollments).toHaveBeenCalledWith("admin-1", [
      { enrollmentId: "enr-1", studentId: "student-1", courseId: "c-1", semesterId: "sem-1" },
    ]);
  });

  // Explicit safety margin against Prisma's default 5s interactive-
  // transaction timeout: each created student also triggers an
  // auto-enroll fan-out (one insert per course), so a batch of any real
  // size can approach the default well before hashing was ever a factor
  // here (student import has no password to hash at all).
  it("opens the transaction with an explicit timeout margin (BULK_TRANSACTION_OPTIONS)", async () => {
    vi.mocked(tx.student.create).mockResolvedValue({
      id: "student-1",
      classId: "class-1",
    } as never);
    vi.mocked(autoEnrollStudentIntoClassCourses).mockResolvedValue([]);

    await confirmStudentImport(
      [{ studentNo: "S1001", fullName: "Jane Doe", gender: "FEMALE", classId: "class-1", phoneNumber: null }],
      "students.xlsx"
    );

    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { timeout: 30000, maxWait: 10000 }
    );
  });
});
