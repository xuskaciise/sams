import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

const mockAdmin = { id: "admin-1" };

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
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
      deleteMany: vi.fn(),
      updateMany: vi.fn(),
      findMany: vi.fn(),
    },
    lecturerCourseAssignment: {
      count: vi.fn(),
    },
    timetableSlot: {
      count: vi.fn(),
    },
    // copyPlanFromClass / moveSemesterPlan pass an array of promises (not a
    // callback) to $transaction, so the mock must handle both forms used
    // across the test suite.
    $transaction: vi.fn(async (arg) =>
      Array.isArray(arg) ? Promise.all(arg) : arg({ classCoursePlan: { create: vi.fn() } })
    ),
  },
}));

import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import {
  addCourseToPlan,
  removeCourseFromPlan,
  copyPlanFromClass,
  previewMoveSemesterPlan,
  moveSemesterPlan,
} from "./actions";

// findMany is called with { where: { classId, semesterNumber }, ... }; the
// helper lets each test describe the source-level and target-level rows.
function mockPlanFindMany(
  bySemesterNumber: Record<number, Array<Record<string, unknown>>>
) {
  vi.mocked(prisma.classCoursePlan.findMany).mockImplementation(
    (async (args: { where: { semesterNumber: number } }) =>
      bySemesterNumber[args.where.semesterNumber] ?? []) as never
  );
}

describe("course plans actions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockAdmin as never);
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

  describe("previewMoveSemesterPlan", () => {
    it("rejects moving a semester level onto itself", async () => {
      await expect(
        previewMoveSemesterPlan({
          classId: "class-1",
          sourceSemesterNumber: 3,
          targetSemesterNumber: 3,
        })
      ).rejects.toThrow("SAME_SEMESTER");
      expect(prisma.classCoursePlan.findMany).not.toHaveBeenCalled();
    });

    it("returns the source course list, the target-level duplicates, and the downstream assignment/slot counts", async () => {
      mockPlanFindMany({
        3: [
          { id: "p1", courseId: "c1", course: { id: "c1", name: "Algebra" } },
          { id: "p2", courseId: "c2", course: { id: "c2", name: "Biology" } },
        ],
        5: [{ courseId: "c2" }],
      });
      vi.mocked(prisma.lecturerCourseAssignment.count).mockResolvedValue(3);
      vi.mocked(prisma.timetableSlot.count).mockResolvedValue(1);

      const result = await previewMoveSemesterPlan({
        classId: "class-1",
        sourceSemesterNumber: 3,
        targetSemesterNumber: 5,
      });

      expect(result).toEqual({
        sourceCourses: [
          { id: "c1", name: "Algebra" },
          { id: "c2", name: "Biology" },
        ],
        targetCourseCount: 1,
        duplicateCourseNames: ["Biology"],
        movingCount: 1,
        assignmentCount: 3,
        timetableSlotCount: 1,
      });
      expect(prisma.lecturerCourseAssignment.count).toHaveBeenCalledWith({
        where: { classId: "class-1", courseId: { in: ["c1", "c2"] } },
      });
      expect(prisma.timetableSlot.count).toHaveBeenCalledWith({
        where: { assignment: { classId: "class-1", courseId: { in: ["c1", "c2"] } } },
      });
    });

    it("skips the downstream count queries entirely when the source level is empty", async () => {
      mockPlanFindMany({ 3: [], 5: [] });

      const result = await previewMoveSemesterPlan({
        classId: "class-1",
        sourceSemesterNumber: 3,
        targetSemesterNumber: 5,
      });

      expect(result).toEqual({
        sourceCourses: [],
        targetCourseCount: 0,
        duplicateCourseNames: [],
        movingCount: 0,
        assignmentCount: 0,
        timetableSlotCount: 0,
      });
      expect(prisma.lecturerCourseAssignment.count).not.toHaveBeenCalled();
      expect(prisma.timetableSlot.count).not.toHaveBeenCalled();
    });
  });

  describe("moveSemesterPlan", () => {
    it("checks the curriculum.manage permission", async () => {
      mockPlanFindMany({
        3: [{ id: "p1", courseId: "c1", course: { id: "c1", name: "Algebra" } }],
        5: [],
      });

      await moveSemesterPlan({
        classId: "class-1",
        sourceSemesterNumber: 3,
        targetSemesterNumber: 5,
      });

      expect(requirePermission).toHaveBeenCalledWith("curriculum.manage");
    });

    it("rejects moving a semester level onto itself", async () => {
      await expect(
        moveSemesterPlan({
          classId: "class-1",
          sourceSemesterNumber: 3,
          targetSemesterNumber: 3,
        })
      ).rejects.toThrow("SAME_SEMESTER");
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("throws NO_COURSES_AT_SOURCE when nothing is planned at the source level", async () => {
      mockPlanFindMany({ 3: [], 5: [] });

      await expect(
        moveSemesterPlan({
          classId: "class-1",
          sourceSemesterNumber: 3,
          targetSemesterNumber: 5,
        })
      ).rejects.toThrow("NO_COURSES_AT_SOURCE");
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("re-points non-duplicate rows to the target level and deletes exact duplicates, in one transaction", async () => {
      mockPlanFindMany({
        3: [
          { id: "p1", courseId: "c1", course: { id: "c1", name: "Algebra" } },
          { id: "p2", courseId: "c2", course: { id: "c2", name: "Biology" } },
        ],
        5: [{ courseId: "c2" }],
      });

      const result = await moveSemesterPlan({
        classId: "class-1",
        sourceSemesterNumber: 3,
        targetSemesterNumber: 5,
      });

      expect(prisma.classCoursePlan.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ["p2"] } },
      });
      expect(prisma.classCoursePlan.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ["p1"] } },
        data: { semesterNumber: 5 },
      });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ moved: 1, skippedDuplicates: 1 });
    });

    it("moves every row when the target level is empty (no delete)", async () => {
      mockPlanFindMany({
        3: [
          { id: "p1", courseId: "c1", course: { id: "c1", name: "Algebra" } },
          { id: "p2", courseId: "c2", course: { id: "c2", name: "Biology" } },
        ],
        5: [],
      });

      const result = await moveSemesterPlan({
        classId: "class-1",
        sourceSemesterNumber: 3,
        targetSemesterNumber: 5,
      });

      expect(prisma.classCoursePlan.deleteMany).not.toHaveBeenCalled();
      expect(prisma.classCoursePlan.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ["p1", "p2"] } },
        data: { semesterNumber: 5 },
      });
      expect(result).toEqual({ moved: 2, skippedDuplicates: 0 });
    });

    it("only deletes (no update) when every source course already exists at the target level", async () => {
      mockPlanFindMany({
        3: [
          { id: "p1", courseId: "c1", course: { id: "c1", name: "Algebra" } },
          { id: "p2", courseId: "c2", course: { id: "c2", name: "Biology" } },
        ],
        5: [{ courseId: "c1" }, { courseId: "c2" }],
      });

      const result = await moveSemesterPlan({
        classId: "class-1",
        sourceSemesterNumber: 3,
        targetSemesterNumber: 5,
      });

      expect(prisma.classCoursePlan.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ["p1", "p2"] } },
      });
      expect(prisma.classCoursePlan.updateMany).not.toHaveBeenCalled();
      expect(result).toEqual({ moved: 0, skippedDuplicates: 2 });
    });

    it("audit-logs the move with the class, source/target levels, and counts", async () => {
      mockPlanFindMany({
        3: [
          { id: "p1", courseId: "c1", course: { id: "c1", name: "Algebra" } },
          { id: "p2", courseId: "c2", course: { id: "c2", name: "Biology" } },
        ],
        5: [{ courseId: "c2" }],
      });

      await moveSemesterPlan({
        classId: "class-1",
        sourceSemesterNumber: 3,
        targetSemesterNumber: 5,
      });

      expect(audit).toHaveBeenCalledWith({
        userId: "admin-1",
        action: "COURSE_PLAN_SEMESTER_MOVED",
        entity: "Class",
        entityId: "class-1",
        oldValue: { semesterNumber: 3, courseCount: 2 },
        newValue: {
          semesterNumber: 5,
          movedCourseCount: 1,
          skippedDuplicateCount: 1,
          movedCourses: ["Algebra"],
        },
      });
    });
  });
});
