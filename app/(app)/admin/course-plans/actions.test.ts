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
    // copyPlanFromClass passes an array of promises (not a callback) to
    // $transaction, so the mock must handle both forms used across the
    // test suite.
    $transaction: vi.fn(async (arg) =>
      Array.isArray(arg) ? Promise.all(arg) : arg({ classCoursePlan: { create: vi.fn() } })
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
    vi.mocked(prisma.$transaction).mockImplementation(async (arg) =>
      Array.isArray(arg)
        ? Promise.all(arg)
        : (arg as (tx: unknown) => unknown)({
            classCoursePlan: { create: vi.fn() },
          })
    );
  });

  describe("addCourseToPlan", () => {
    it("translates a unique-constraint violation into ALREADY_IN_PLAN", async () => {
      vi.mocked(prisma.classCoursePlan.create).mockRejectedValue(
        duplicateError()
      );

      await expect(
        addCourseToPlan("class-1", "course-1", 1)
      ).rejects.toThrow("ALREADY_IN_PLAN");
    });

    it("adds the course to the class's plan at the given semester level", async () => {
      await addCourseToPlan("class-1", "course-1", 2);

      expect(prisma.classCoursePlan.create).toHaveBeenCalledWith({
        data: { classId: "class-1", courseId: "course-1", semesterNumber: 2 },
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
      await expect(
        copyPlanFromClass("class-1", "class-1", 1)
      ).rejects.toThrow("SAME_CLASS");
      expect(prisma.classCoursePlan.findMany).not.toHaveBeenCalled();
    });

    it("copies every course from the source plan at that level not already present, and counts them", async () => {
      vi.mocked(prisma.classCoursePlan.findMany).mockImplementation(
        (async (args: { where: { classId: string; semesterNumber: number } }) =>
          args.where.classId === "class-1"
            ? [{ courseId: "course-1" }, { courseId: "course-2" }]
            : []) as never
      );

      const result = await copyPlanFromClass("class-2", "class-1", 1);

      expect(prisma.classCoursePlan.create).toHaveBeenCalledTimes(2);
      expect(prisma.classCoursePlan.create).toHaveBeenCalledWith({
        data: { classId: "class-2", courseId: "course-1", semesterNumber: 1 },
      });
      expect(result).toEqual({ copied: 2 });
    });

    it("pre-checks the target's existing plan at that level and only copies courses not already present — never attempting (and failing on) a duplicate create", async () => {
      // Catching a unique-constraint violation mid-transaction does NOT let
      // Postgres continue to the next statement — the whole transaction
      // aborts from that point on. So the overlap must be filtered out via
      // a query before any create() is attempted.
      vi.mocked(prisma.classCoursePlan.findMany).mockImplementation(
        (async (args: { where: { classId: string; semesterNumber: number } }) =>
          args.where.classId === "class-1"
            ? [{ courseId: "course-1" }, { courseId: "course-2" }]
            : [{ courseId: "course-1" }]) as never
      );

      const result = await copyPlanFromClass("class-2", "class-1", 1);

      expect(prisma.classCoursePlan.create).toHaveBeenCalledTimes(1);
      expect(prisma.classCoursePlan.create).toHaveBeenCalledWith({
        data: { classId: "class-2", courseId: "course-2", semesterNumber: 1 },
      });
      expect(result).toEqual({ copied: 1 });
    });

    it("does nothing when every source course is already in the target plan", async () => {
      vi.mocked(prisma.classCoursePlan.findMany).mockImplementation(
        (async (args: { where: { classId: string; semesterNumber: number } }) =>
          args.where.classId === "class-1"
            ? [{ courseId: "course-1" }]
            : [{ courseId: "course-1" }]) as never
      );

      const result = await copyPlanFromClass("class-2", "class-1", 1);

      expect(prisma.classCoursePlan.create).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(result).toEqual({ copied: 0 });
    });
  });
});
