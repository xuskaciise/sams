import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

const mockAdmin = { id: "admin-1" };

vi.mock("@/lib/auth", () => ({
  requireRole: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

function duplicateError() {
  return new Prisma.PrismaClientKnownRequestError("duplicate", {
    code: "P2002",
    clientVersion: "test",
  });
}

function makeTx() {
  return {
    class: { create: vi.fn() },
    student: { updateMany: vi.fn() },
  };
}

let tx = makeTx();

vi.mock("@/lib/db", () => ({
  prisma: {
    class: { findUniqueOrThrow: vi.fn() },
    $transaction: vi.fn(async (fn) => fn(tx)),
  },
}));

import { requireRole } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { transferStudents } from "./actions";

describe("transferStudents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tx = makeTx();
    vi.mocked(prisma.$transaction).mockImplementation(async (fn) =>
      (fn as (tx: unknown) => unknown)(tx)
    );
    vi.mocked(requireRole).mockResolvedValue(mockAdmin as never);
    vi.mocked(prisma.class.findUniqueOrThrow).mockResolvedValue({
      id: "class-source",
      programId: "program-1",
    } as never);
    vi.mocked(tx.student.updateMany).mockResolvedValue({ count: 2 } as never);
  });

  it("refuses to transfer a class onto itself", async () => {
    await expect(
      transferStudents({
        sourceClassId: "class-source",
        target: { mode: "existing", classId: "class-source" },
        studentIds: ["s1"],
      })
    ).rejects.toThrow("SAME_CLASS");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("only updates classId for the checked students still in the source class", async () => {
    await transferStudents({
      sourceClassId: "class-source",
      target: { mode: "existing", classId: "class-target" },
      studentIds: ["s1", "s2"],
    });

    expect(tx.student.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["s1", "s2"] }, classId: "class-source" },
      data: { classId: "class-target" },
    });
    expect(tx.class.create).not.toHaveBeenCalled();
  });

  it("creates the target class in the source's program when mode is 'new'", async () => {
    vi.mocked(tx.class.create).mockResolvedValue({ id: "class-new" } as never);

    await transferStudents({
      sourceClassId: "class-source",
      target: { mode: "new", name: "CMS2518-C-FT" },
      studentIds: ["s1"],
    });

    expect(tx.class.create).toHaveBeenCalledWith({
      data: { name: "CMS2518-C-FT", programId: "program-1" },
    });
    expect(tx.student.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["s1"] }, classId: "class-source" },
      data: { classId: "class-new" },
    });
  });

  it("translates a duplicate class name into DUPLICATE_CLASS_NAME", async () => {
    vi.mocked(prisma.$transaction).mockRejectedValue(duplicateError());

    await expect(
      transferStudents({
        sourceClassId: "class-source",
        target: { mode: "new", name: "CMS2518-C-FT" },
        studentIds: ["s1"],
      })
    ).rejects.toThrow("DUPLICATE_CLASS_NAME");
  });

  it("audits STUDENTS_TRANSFERRED with both class ids and the actual transferred count", async () => {
    vi.mocked(tx.student.updateMany).mockResolvedValue({ count: 1 } as never);

    await transferStudents({
      sourceClassId: "class-source",
      target: { mode: "existing", classId: "class-target" },
      studentIds: ["s1", "s2"], // one of these no longer matches classId: source
    });

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "admin-1",
        action: "STUDENTS_TRANSFERRED",
        entity: "Class",
        entityId: "class-source",
        newValue: {
          sourceClassId: "class-source",
          targetClassId: "class-target",
          studentCount: 1,
        },
      })
    );
  });

  it("enforces admin-only access before touching anything", async () => {
    vi.mocked(requireRole).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(
      transferStudents({
        sourceClassId: "class-source",
        target: { mode: "existing", classId: "class-target" },
        studentIds: ["s1"],
      })
    ).rejects.toThrow("FORBIDDEN");
    expect(prisma.class.findUniqueOrThrow).not.toHaveBeenCalled();
  });
});
