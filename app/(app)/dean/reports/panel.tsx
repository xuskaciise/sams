import { prisma } from "@/lib/db";
import { ReportsClient } from "./reports-client";

export async function ReportsPanel() {
  const [assignments, classes, semesters, students] = await Promise.all([
    prisma.lecturerCourseAssignment.findMany({
      include: {
        lecturer: { include: { user: true } },
        course: true,
        class: true,
        semester: { include: { academicYear: true } },
      },
      orderBy: [{ semester: { startDate: "desc" } }, { course: { name: "asc" } }],
    }),
    prisma.class.findMany({
      where: { deletedAt: null },
      orderBy: { name: "asc" },
    }),
    prisma.semester.findMany({
      include: { academicYear: true },
      orderBy: { startDate: "desc" },
    }),
    prisma.student.findMany({
      orderBy: { fullName: "asc" },
    }),
  ]);

  return (
    <ReportsClient
      assignments={assignments}
      classes={classes}
      semesters={semesters}
      students={students}
    />
  );
}
