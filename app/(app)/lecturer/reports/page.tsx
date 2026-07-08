import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ReportsClient } from "./reports-client";

export default async function LecturerReportsPage() {
  const user = await getCurrentUser();

  const assignments = await prisma.lecturerCourseAssignment.findMany({
    where: { lecturer: { userId: user!.id } },
    include: {
      course: true,
      class: true,
      semester: { include: { academicYear: true } },
    },
    orderBy: [{ semester: { startDate: "desc" } }, { course: { name: "asc" } }],
  });

  return <ReportsClient assignments={assignments} />;
}
