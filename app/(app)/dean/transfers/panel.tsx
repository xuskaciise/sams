import { prisma } from "@/lib/db";
import { TransfersClient } from "./transfers-client";

export async function TransfersPanel() {
  const [assignments, lecturers] = await Promise.all([
    prisma.lecturerCourseAssignment.findMany({
      where: { semester: { isClosed: false } },
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
      where: { user: { deletedAt: null } },
      orderBy: { user: { fullName: "asc" } },
    }),
  ]);

  return <TransfersClient assignments={assignments} lecturers={lecturers} />;
}
