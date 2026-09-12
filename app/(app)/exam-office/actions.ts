"use server";

import * as XLSX from "xlsx";
import { requirePermission } from "@/lib/auth";
import { formatClassLabel } from "@/lib/class-label";
import { buildExamOfficeWhere, getExamOfficeRecords, type ExamOfficeFilters } from "./queries";

type CellValue = string | number;

function buildWorkbookBase64(rows: CellValue[][]): string {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, worksheet, "Missed Exams");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  return Buffer.from(buffer).toString("base64");
}

const EXAM_TYPE_LABEL: Record<string, string> = {
  MIDTERM: "Midterm",
  FINAL: "Final",
  BOTH: "Both",
};

const REASON_TYPE_LABEL: Record<string, string> = {
  ILLNESS: "Illness",
  CHEATING: "Cheating",
  EMERGENCY: "Emergency",
  OTHER: "Other",
};

// Read-only, university-wide export — no dean_departments scoping (see
// queries.ts's module comment); exam.records.view is the whole boundary
// here, same as the on-screen report itself.
export async function exportMissedExamReport(filters: ExamOfficeFilters) {
  await requirePermission("exam.records.view");
  const where = buildExamOfficeWhere(filters);
  // A bounded, generous cap — this is a reporting export, not a paginated
  // fetch; 5000 rows is comfortably beyond any realistic single export.
  const { records } = await getExamOfficeRecords(where, 0, 5000);

  const rows: CellValue[][] = [
    [
      "Student No",
      "Student Name",
      "Faculty",
      "Course",
      "Class",
      "Semester",
      "Exam Type",
      "Reason",
      "Note",
      "Recorded By",
      "Recorded At",
    ],
    ...records.map((r) => [
      r.student.studentNo,
      r.student.fullName,
      r.assignment.class.program.department.name,
      `${r.course.name} (${r.course.code})`,
      formatClassLabel(r.assignment.class),
      `${r.semester.name} (${r.semester.academicYear.name})`,
      EXAM_TYPE_LABEL[r.examType] ?? r.examType,
      REASON_TYPE_LABEL[r.reasonType] ?? r.reasonType,
      r.reasonNote ?? "",
      r.recordedBy.fullName,
      r.recordedAt.toLocaleString(),
    ]),
  ];

  const base64 = buildWorkbookBase64(rows);
  return { base64, fileName: "Missed_Exam_Records.xlsx" };
}
