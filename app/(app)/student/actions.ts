"use server";

import * as XLSX from "xlsx";
import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";

type CellValue = string | number;

function buildWorkbookBase64(rows: CellValue[][]): string {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, worksheet, "My Results");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  return Buffer.from(buffer).toString("base64");
}

function safeFileName(name: string): string {
  return `${name.replace(/[^a-z0-9.-]+/gi, "_")}.xlsx`;
}

function pct(value: number | null): CellValue {
  return value !== null ? Number(value.toFixed(2)) : "";
}

// Exports the CALLING student's own published marks only — studentId is
// always resolved from the session (requirePermission -> userId -> Student),
// never accepted as a parameter, so there is no way to request another
// student's transcript through this action.
export async function exportMyResults() {
  const user = await requirePermission("results.view.own");

  const student = await prisma.student.findUnique({ where: { userId: user.id } });
  if (!student) throw new Error("NOT_FOUND");

  const enrollments = await prisma.studentCourseEnrollment.findMany({
    where: { studentId: student.id },
    include: {
      course: true,
      class: true,
      semester: { include: { academicYear: true } },
    },
    orderBy: [{ semester: { startDate: "desc" } }, { course: { name: "asc" } }],
  });

  const publishedResults = enrollments.length
    ? await prisma.assessmentResult.findMany({
        where: {
          enrollmentId: { in: enrollments.map((e) => e.id) },
          status: "PUBLISHED",
        },
        include: { assessment: { select: { maximumMarks: true } } },
      })
    : [];

  const resultsByEnrollment = new Map<string, typeof publishedResults>();
  for (const result of publishedResults) {
    resultsByEnrollment.set(result.enrollmentId, [
      ...(resultsByEnrollment.get(result.enrollmentId) ?? []),
      result,
    ]);
  }

  const rows: CellValue[][] = [
    ["Course", "Class", "Semester", "Status", "Earned", "Possible", "Percentage"],
    ...enrollments.map((enrollment) => {
      const results = resultsByEnrollment.get(enrollment.id) ?? [];
      const earned = results.reduce(
        (sum, r) => sum + (r.mark !== null ? Number(r.mark) : 0),
        0
      );
      const possible = results.reduce(
        (sum, r) => sum + Number(r.assessment.maximumMarks),
        0
      );
      return [
        `${enrollment.course.name} (${enrollment.course.code})`,
        enrollment.class.name,
        `${enrollment.semester.name} (${enrollment.semester.academicYear.name})`,
        enrollment.status,
        earned,
        possible,
        pct(possible > 0 ? (earned / possible) * 100 : null),
      ];
    }),
  ];

  const base64 = buildWorkbookBase64(rows);
  return {
    base64,
    fileName: safeFileName(`My-Results-${student.studentNo}`),
  };
}
