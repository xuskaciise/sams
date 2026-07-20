import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import {
  getDeanDepartmentIds,
  assignmentDeanWhere,
  classDeanWhere,
  studentDeanWhere,
} from "@/lib/dean-scope";
import { ReportsClient } from "./reports-client";

export async function ReportsPanel() {
  const user = await getCurrentUser();
  const departmentIds = await getDeanDepartmentIds(user!.id);

  if (departmentIds.length === 0) {
    return (
      <ReportsClient assignments={[]} classes={[]} semesters={[]} students={[]} unassigned />
    );
  }

  const [assignments, classes, semesters, students] = await Promise.all([
    prisma.lecturerCourseAssignment.findMany({
      where: assignmentDeanWhere(departmentIds),
      include: {
        lecturer: { include: { user: true } },
        course: true,
        class: true,
        semester: { include: { academicYear: true } },
      },
      orderBy: [{ semester: { startDate: "desc" } }, { course: { name: "asc" } }],
    }),
    prisma.class.findMany({
      where: { deletedAt: null, ...classDeanWhere(departmentIds) },
      orderBy: { name: "asc" },
    }),
    // Semesters are a global calendar concept, not faculty-scoped — the
    // picker just needs a semester to pair with a scoped class, and a
    // semester by itself carries no faculty-sensitive data.
    prisma.semester.findMany({
      include: { academicYear: true },
      orderBy: { startDate: "desc" },
    }),
    prisma.student.findMany({
      where: studentDeanWhere(departmentIds),
      orderBy: { fullName: "asc" },
    }),
  ]);

  return (
    <ReportsClient
      assignments={assignments}
      classes={classes}
      semesters={semesters}
      students={students}
      unassigned={false}
    />
  );
}
