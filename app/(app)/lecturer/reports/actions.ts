"use server";

import * as XLSX from "xlsx";
import { requireRole } from "@/lib/auth";
import { getClassResultReport } from "./queries";

export async function fetchClassResultReport(assignmentId: string) {
  const user = await requireRole("LECTURER");
  return getClassResultReport(user.id, assignmentId);
}

type CellValue = string | number;

function safeFileName(name: string): string {
  return `${name.replace(/[^a-z0-9.-]+/gi, "_")}.xlsx`;
}

export async function exportClassResultReport(assignmentId: string) {
  const user = await requireRole("LECTURER");
  const report = await getClassResultReport(user.id, assignmentId);
  if (!report) throw new Error("NOT_FOUND");

  const header: CellValue[] = [
    "Student No",
    "Student Name",
    "Group",
    ...report.assessments.map(
      (a) => `${a.title}${a.status === "DRAFT" ? " (Draft)" : ""} /${a.maximumMarks}`
    ),
    "Total",
    "Possible",
    "%",
  ];

  const rows: CellValue[][] = report.students.map((s) => [
    s.studentNo,
    s.studentName,
    s.groupName ?? "",
    ...report.assessments.map((a) => {
      const m = s.marks[a.id];
      if (!m) return "";
      if (m.attendanceStatus !== "PRESENT") return m.attendanceStatus;
      return m.mark ?? "";
    }),
    s.earned,
    s.possible,
    s.percentage !== null ? Number(s.percentage.toFixed(2)) : "",
  ]);

  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet([header, ...rows]);
  XLSX.utils.book_append_sheet(workbook, worksheet, "Results");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  const base64 = Buffer.from(buffer).toString("base64");

  return {
    base64,
    fileName: safeFileName(
      `${report.assignment.course.name}-${report.assignment.class.name}-${report.assignment.semester.name}`
    ),
  };
}
