import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    shift: { create: vi.fn(), update: vi.fn() },
  },
}));

import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { createShift, updateShift, deactivateShift, reactivateShift } from "./actions";

const validInput = {
  name: "Shift 1",
  studyMode: "FT" as const,
  startTime: "08:00",
  endTime: "12:00",
};

describe("Shift CRUD", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue({ id: "admin-1" } as never);
  });

  it("createShift enforces shift.manage before writing", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(createShift(validInput)).rejects.toThrow("FORBIDDEN");
    expect(prisma.shift.create).not.toHaveBeenCalled();
  });

  it("createShift persists name, studyMode, and times", async () => {
    await createShift(validInput);

    expect(prisma.shift.create).toHaveBeenCalledWith({
      data: {
        name: "Shift 1",
        studyMode: "FT",
        startTime: "08:00",
        endTime: "12:00",
      },
    });
  });

  it("rejects an end time that is not after the start time", async () => {
    await expect(
      createShift({ ...validInput, startTime: "12:00", endTime: "08:00" })
    ).rejects.toThrow();
    expect(prisma.shift.create).not.toHaveBeenCalled();
  });

  it("updateShift enforces shift.manage before writing", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(updateShift("shift-1", validInput)).rejects.toThrow("FORBIDDEN");
    expect(prisma.shift.update).not.toHaveBeenCalled();
  });

  it("deactivateShift sets deletedAt", async () => {
    await deactivateShift("shift-1");
    expect(prisma.shift.update).toHaveBeenCalledWith({
      where: { id: "shift-1" },
      data: { deletedAt: expect.any(Date) },
    });
  });

  it("reactivateShift clears deletedAt", async () => {
    await reactivateShift("shift-1");
    expect(prisma.shift.update).toHaveBeenCalledWith({
      where: { id: "shift-1" },
      data: { deletedAt: null },
    });
  });
});
