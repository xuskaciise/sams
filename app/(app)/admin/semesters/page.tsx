import { prisma } from "@/lib/db";
import { SemestersClient } from "./semesters-client";

export default async function SemestersPage() {
  const [semesters, academicYears] = await Promise.all([
    prisma.semester.findMany({
      include: { academicYear: true },
      orderBy: { startDate: "desc" },
    }),
    prisma.academicYear.findMany({
      orderBy: { name: "asc" },
    }),
  ]);

  return <SemestersClient semesters={semesters} academicYears={academicYears} />;
}
