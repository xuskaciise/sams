import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import {
  getDeanDepartmentIds,
  assignmentDeanWhere,
  lecturerDeanWhere,
} from "@/lib/dean-scope";
import { TransfersClient } from "./transfers-client";

export async function TransfersPanel() {
  const user = await getCurrentUser();
  const departmentIds = await getDeanDepartmentIds(user!.id);

  if (departmentIds.length === 0) {
    return <TransfersClient assignments={[]} lecturers={[]} unassigned />;
  }

  const [assignments, lecturers] = await Promise.all([
    prisma.lecturerCourseAssignment.findMany({
      where: {
        semester: { isClosed: false },
        ...assignmentDeanWhere(departmentIds),
      },
      include: {
        lecturer: true,
        course: true,
        class: true,
        semester: { include: { academicYear: true } },
      },
      orderBy: [{ semester: { startDate: "desc" } }, { course: { name: "asc" } }],
    }),
    // The transfer TARGET must already have a login account (they need to
    // immediately pick up editing/publishing/correcting) — unlike other
    // lecturer pickers in the app, this one deliberately keeps the
    // account-required filter.
    prisma.lecturer.findMany({
      where: { user: { deletedAt: null }, ...lecturerDeanWhere(departmentIds) },
      orderBy: { fullName: "asc" },
    }),
  ]);

  return (
    <TransfersClient
      assignments={assignments}
      lecturers={lecturers}
      unassigned={false}
    />
  );
}
