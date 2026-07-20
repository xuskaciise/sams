import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    deanDepartment: { findMany: vi.fn() },
  },
}));

import { prisma } from "@/lib/db";
import {
  getDeanDepartmentIds,
  classDeanWhere,
  assignmentDeanWhere,
  enrollmentDeanWhere,
  assessmentDeanWhere,
  resultDeanWhere,
  studentDeanWhere,
  lecturerDeanWhere,
} from "./dean-scope";

describe("getDeanDepartmentIds", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns the department ids a dean oversees", async () => {
    vi.mocked(prisma.deanDepartment.findMany).mockResolvedValue([
      { departmentId: "dept-cs" },
      { departmentId: "dept-eng" },
    ] as never);

    expect(await getDeanDepartmentIds("dean-1")).toEqual(["dept-cs", "dept-eng"]);
    expect(prisma.deanDepartment.findMany).toHaveBeenCalledWith({
      where: { userId: "dean-1" },
      select: { departmentId: true },
    });
  });

  it("returns an empty array for an unassigned dean", async () => {
    vi.mocked(prisma.deanDepartment.findMany).mockResolvedValue([]);

    expect(await getDeanDepartmentIds("dean-2")).toEqual([]);
  });
});

// Every where-builder nests the same base predicate at the right relation
// depth. An empty departmentIds array must still produce a valid `{ in: [] }`
// clause (matches nothing) rather than, say, an unbounded/missing filter —
// that's what makes "unassigned dean sees nothing" automatic everywhere.
describe("dean scope where-builders", () => {
  const ids = ["dept-1", "dept-2"];

  it("classDeanWhere nests under program", () => {
    expect(classDeanWhere(ids)).toEqual({
      program: { departmentId: { in: ids } },
    });
  });

  it("assignmentDeanWhere nests under class.program", () => {
    expect(assignmentDeanWhere(ids)).toEqual({
      class: { program: { departmentId: { in: ids } } },
    });
  });

  it("enrollmentDeanWhere nests under class.program", () => {
    expect(enrollmentDeanWhere(ids)).toEqual({
      class: { program: { departmentId: { in: ids } } },
    });
  });

  it("assessmentDeanWhere nests under assignment.class.program", () => {
    expect(assessmentDeanWhere(ids)).toEqual({
      assignment: { class: { program: { departmentId: { in: ids } } } },
    });
  });

  it("resultDeanWhere nests under enrollment.class.program", () => {
    expect(resultDeanWhere(ids)).toEqual({
      enrollment: { class: { program: { departmentId: { in: ids } } } },
    });
  });

  it("studentDeanWhere nests under class.program", () => {
    expect(studentDeanWhere(ids)).toEqual({
      class: { program: { departmentId: { in: ids } } },
    });
  });

  it("lecturerDeanWhere requires at least one in-scope assignment", () => {
    expect(lecturerDeanWhere(ids)).toEqual({
      assignments: {
        some: { class: { program: { departmentId: { in: ids } } } },
      },
    });
  });

  it("an empty departmentIds array still produces an `in: []` clause everywhere, matching nothing", () => {
    expect(classDeanWhere([])).toEqual({ program: { departmentId: { in: [] } } });
    expect(lecturerDeanWhere([])).toEqual({
      assignments: { some: { class: { program: { departmentId: { in: [] } } } } },
    });
  });
});
