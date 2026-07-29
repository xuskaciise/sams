import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAdmin = { id: "admin-1" };

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    student: { findUniqueOrThrow: vi.fn(), update: vi.fn() },
  },
}));

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { requirePermission } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { updateStudentPhoneNumber } from "./actions";

describe("updateStudentPhoneNumber", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockAdmin as never);
    vi.mocked(prisma.student.findUniqueOrThrow).mockResolvedValue({
      id: "student-1",
      phoneNumber: null,
    } as never);
    vi.mocked(prisma.student.update).mockResolvedValue({
      id: "student-1",
      phoneNumber: "+252611111111",
    } as never);
  });

  it("requires students.manage before touching anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(
      updateStudentPhoneNumber("student-1", { phoneNumber: "+252611111111" })
    ).rejects.toThrow("FORBIDDEN");
    expect(prisma.student.update).not.toHaveBeenCalled();
  });

  it("rejects a malformed phone number", async () => {
    await expect(
      updateStudentPhoneNumber("student-1", { phoneNumber: "not-a-phone" })
    ).rejects.toThrow();
    expect(prisma.student.update).not.toHaveBeenCalled();
  });

  it("saves a valid phone number", async () => {
    await updateStudentPhoneNumber("student-1", { phoneNumber: "+252611111111" });

    expect(prisma.student.update).toHaveBeenCalledWith({
      where: { id: "student-1" },
      data: { phoneNumber: "+252611111111" },
    });
  });

  it("treats an empty string as clearing the phone number", async () => {
    await updateStudentPhoneNumber("student-1", { phoneNumber: "" });

    expect(prisma.student.update).toHaveBeenCalledWith({
      where: { id: "student-1" },
      data: { phoneNumber: null },
    });
  });

  it("audits STUDENT_PHONE_UPDATED with old and new values", async () => {
    await updateStudentPhoneNumber("student-1", { phoneNumber: "+252611111111" });

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "admin-1",
        action: "STUDENT_PHONE_UPDATED",
        entity: "Student",
        entityId: "student-1",
        oldValue: { phoneNumber: null },
        newValue: { phoneNumber: "+252611111111" },
      })
    );
  });
});
