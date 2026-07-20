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
        lecturer: { include: { user: true } },
        course: true,
        class: true,
        semester: { include: { academicYear: true } },
      },
      orderBy: [{ semester: { startDate: "desc" } }, { course: { name: "asc" } }],
    }),
    prisma.lecturer.findMany({
      include: { user: true },
      where: { user: { deletedAt: null }, ...lecturerDeanWhere(departmentIds) },
      orderBy: { user: { fullName: "asc" } },
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
