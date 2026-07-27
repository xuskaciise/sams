import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    campus: { create: vi.fn(), update: vi.fn() },
  },
}));

import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { createCampus, updateCampus, deactivateCampus, reactivateCampus } from "./actions";

describe("Campus CRUD", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue({ id: "user-1" } as never);
  });

  it("createCampus enforces timetable.manage before writing", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(createCampus({ name: "Main Campus" })).rejects.toThrow("FORBIDDEN");
    expect(prisma.campus.create).not.toHaveBeenCalled();
  });

  it("createCampus persists name and address, defaulting a blank address to null", async () => {
    await createCampus({ name: "Main Campus", address: "123 University Ave" });
    expect(prisma.campus.create).toHaveBeenCalledWith({
      data: { name: "Main Campus", address: "123 University Ave" },
    });

    await createCampus({ name: "North Campus" });
    expect(prisma.campus.create).toHaveBeenCalledWith({
      data: { name: "North Campus", address: null },
    });
  });

  it("updateCampus enforces timetable.manage before writing", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(updateCampus("campus-1", { name: "Main Campus" })).rejects.toThrow("FORBIDDEN");
    expect(prisma.campus.update).not.toHaveBeenCalled();
  });

  it("deactivateCampus sets deletedAt", async () => {
    await deactivateCampus("campus-1");
    expect(prisma.campus.update).toHaveBeenCalledWith({
      where: { id: "campus-1" },
      data: { deletedAt: expect.any(Date) },
    });
  });

  it("reactivateCampus clears deletedAt", async () => {
    await reactivateCampus("campus-1");
    expect(prisma.campus.update).toHaveBeenCalledWith({
      where: { id: "campus-1" },
      data: { deletedAt: null },
    });
  });
});
