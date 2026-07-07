import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

const mockAdmin = { id: "admin-1" };

vi.mock("@/lib/auth", () => ({
  requireRole: vi.fn(),
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

vi.mock("@/lib/db", () => ({
  prisma: {
    classCoursePlan: {
      create: vi.fn(),
      delete: vi.fn(),
      findMany: vi.fn(),
    },
    $transaction: vi.fn(async (fn) =>
      fn({
        classCoursePlan: { create: vi.fn() },
      })
    ),
  },
}));

import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  addCourseToPlan,
  removeCourseFromPlan,
  copyPlanFromClass,
} from "./actions";

describe("course plans actions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requireRole).mockResolvedValue(mockAdmin as never);
  });

  describe("addCourseToPlan", () => {
    it("translates a unique-constraint violation into ALREADY_IN_PLAN", async () => {
      vi.mocked(prisma.classCoursePlan.create).mockRejectedValue(
        duplicateError()
      );

      await expect(addCourseToPlan("class-1", "course-1")).rejects.toThrow(
        "ALREADY_IN_PLAN"
      );
    });

    it("adds the course to the class's plan", async () => {
      await addCourseToPlan("class-1", "course-1");

      expect(prisma.classCoursePlan.create).toHaveBeenCalledWith({
        data: { classId: "class-1", courseId: "course-1" },
      });
    });
  });

  describe("removeCourseFromPlan", () => {
    it("deletes the plan row", async () => {
      await removeCourseFromPlan("plan-1");

      expect(prisma.classCoursePlan.delete).toHaveBeenCalledWith({
        where: { id: "plan-1" },
      });
    });
  });

  describe("copyPlanFromClass", () => {
    it("refuses to copy a class's plan onto itself", async () => {
      await expect(copyPlanFromClass("class-1", "class-1")).rejects.toThrow(
        "SAME_CLASS"
      );
      expect(prisma.classCoursePlan.findMany).not.toHaveBeenCalled();
    });

    it("copies every course from the source plan not already present, and counts them", async () => {
      vi.mocked(prisma.classCoursePlan.findMany).mockResolvedValue([
        { courseId: "course-1" },
        { courseId: "course-2" },
      ] as never);
      const txCreate = vi.fn();
      vi.mocked(prisma.$transaction).mockImplementation(async (fn) =>
        (fn as (tx: unknown) => unknown)({
          classCoursePlan: { create: txCreate },
        })
      );

      const result = await copyPlanFromClass("class-2", "class-1");

      expect(txCreate).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ copied: 2 });
    });

    it("skips courses that already exist in the target plan without failing the whole copy", async () => {
      vi.mocked(prisma.classCoursePlan.findMany).mockResolvedValue([
        { courseId: "course-1" },
        { courseId: "course-2" },
      ] as never);
      const txCreate = vi
        .fn()
        .mockRejectedValueOnce(duplicateError())
        .mockResolvedValueOnce({});
      vi.mocked(prisma.$transaction).mockImplementation(async (fn) =>
        (fn as (tx: unknown) => unknown)({
          classCoursePlan: { create: txCreate },
        })
      );

      const result = await copyPlanFromClass("class-2", "class-1");

      expect(result).toEqual({ copied: 1 });
    });
  });
});
