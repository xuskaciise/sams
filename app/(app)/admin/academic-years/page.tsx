import { prisma } from "@/lib/db";
import { AcademicYearsClient } from "./academic-years-client";

export default async function AcademicYearsPage() {
  const academicYears = await prisma.academicYear.findMany({
    orderBy: { startDate: "desc" },
  });

  return <AcademicYearsClient academicYears={academicYears} />;
}
