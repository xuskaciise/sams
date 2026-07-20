// A user can hold BOTH the DEAN and LECTURER roles at once (multi-role is
// supported everywhere — see lib/permissions.ts). This must not blur the
// two scoping systems: the dean side of that user's session is scoped by
// dean_departments (lib/dean-scope.ts), the lecturer side stays scoped by
// assignment ownership (`lecturer: { userId }`, unchanged by this feature)
// — completely independent mechanisms keyed off the same userId.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    deanDepartment: { findMany: vi.fn() },
    lecturerCourseAssignment: { findFirst: vi.fn() },
    studentCourseEnrollment: { findMany: vi.fn() },
    assessment: { findMany: vi.fn() },
    studentGroup: { findMany: vi.fn() },
  },
}));

import { prisma } from "@/lib/db";
import { getDeanDepartmentIds } from "@/lib/dean-scope";
import { getClassResultReport } from "@/app/(app)/lecturer/reports/queries";

const MULTI_ROLE_USER = "multi-role-user-1";

describe("a DEAN+LECTURER multi-role user", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("dean-side scoping only ever reads dean_departments — never touched by lecturer assignments", async () => {
    vi.mocked(prisma.deanDepartment.findMany).mockResolvedValue([
      { departmentId: "dept-cs" },
    ] as never);

    const departmentIds = await getDeanDepartmentIds(MULTI_ROLE_USER);

    expect(departmentIds).toEqual(["dept-cs"]);
    expect(prisma.deanDepartment.findMany).toHaveBeenCalledWith({
      where: { userId: MULTI_ROLE_USER },
      select: { departmentId: true },
    });
    // Nothing about this lookup consults lecturer/assignment tables.
    expect(prisma.lecturerCourseAssignment.findFirst).not.toHaveBeenCalled();
  });

  it("lecturer-side scoping stays ownership-scoped by assignment, with no department/faculty filter at all", async () => {
    vi.mocked(prisma.lecturerCourseAssignment.findFirst).mockResolvedValue({
      id: "assign-1",
      courseId: "course-1",
      classId: "class-1",
      semesterId: "sem-1",
      course: { name: "Databases" },
      class: { name: "CMS2518-A-FT" },
      semester: { name: "Semester 1", academicYear: { name: "2025-2026" } },
    } as never);
    vi.mocked(prisma.studentCourseEnrollment.findMany).mockResolvedValue([]);
    vi.mocked(prisma.assessment.findMany).mockResolvedValue([]);
    vi.mocked(prisma.studentGroup.findMany).mockResolvedValue([]);

    await getClassResultReport(MULTI_ROLE_USER, "assign-1");

    // Ownership scoping only — `lecturer: { userId }` on the assignment
    // itself, exactly as before this feature. No `department`/`program`
    // key anywhere in the where clause.
    expect(prisma.lecturerCourseAssignment.findFirst).toHaveBeenCalledWith({
      where: { id: "assign-1", lecturer: { userId: MULTI_ROLE_USER } },
      include: expect.any(Object),
    });
    // And the dean-departments table is never consulted for the lecturer
    // side at all.
    expect(prisma.deanDepartment.findMany).not.toHaveBeenCalled();
  });

  it("an unassigned dean who is ALSO a lecturer still keeps full access to their own assignments", async () => {
    vi.mocked(prisma.deanDepartment.findMany).mockResolvedValue([]);
    vi.mocked(prisma.lecturerCourseAssignment.findFirst).mockResolvedValue({
      id: "assign-1",
      courseId: "course-1",
      classId: "class-1",
      semesterId: "sem-1",
      course: { name: "Databases" },
      class: { name: "CMS2518-A-FT" },
      semester: { name: "Semester 1", academicYear: { name: "2025-2026" } },
    } as never);
    vi.mocked(prisma.studentCourseEnrollment.findMany).mockResolvedValue([]);
    vi.mocked(prisma.assessment.findMany).mockResolvedValue([]);
    vi.mocked(prisma.studentGroup.findMany).mockResolvedValue([]);

    const departmentIds = await getDeanDepartmentIds(MULTI_ROLE_USER);
    expect(departmentIds).toEqual([]); // dean side: sees nothing yet

    const report = await getClassResultReport(MULTI_ROLE_USER, "assign-1");
    expect(report).not.toBeNull(); // lecturer side: unaffected
  });
});
