"use server";

import * as XLSX from "xlsx";
import { requirePermission } from "@/lib/auth";
import { getCourseReport, getClassReport, getStudentReport } from "./queries";

export async function fetchCourseReport(assignmentId: string) {
  await requirePermission("reports.view.all");
  return getCourseReport(assignmentId);
}

export async function fetchClassReport(classId: string, semesterId: string) {
  await requirePermission("reports.view.all");
  return getClassReport(classId, semesterId);
}

export async function fetchStudentReport(studentId: string) {
  await requirePermission("reports.view.all");
  return getStudentReport(studentId);
}

type CellValue = string | number;

function buildWorkbookBase64(sheets: { name: string; rows: CellValue[][] }[]): string {
  const workbook = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const worksheet = XLSX.utils.aoa_to_sheet(sheet.rows);
    XLSX.utils.book_append_sheet(workbook, worksheet, sheet.name);
  }
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  return Buffer.from(buffer).toString("base64");
}

function safeFileName(name: string): string {
  return `${name.replace(/[^a-z0-9.-]+/gi, "_")}.xlsx`;
}

function pct(value: number | null): CellValue {
  return value !== null ? Number(value.toFixed(2)) : "";
}

export async function exportCourseReport(assignmentId: string) {
  await requirePermission("reports.view.all");
  const report = await getCourseReport(assignmentId);
  if (!report) throw new Error("NOT_FOUND");

  const studentRows: CellValue[][] = [
    ["Student No", "Student Name", "Earned", "Possible", "Percentage"],
    ...report.studentTotals.map((s) => [
      s.studentNo,
      s.studentName,
      s.earned,
      s.possible,
      pct(s.percentage),
    ]),
  ];
  const assessmentRows: CellValue[][] = [
    ["Title", "Type", "Max Marks", "Status", "Graded", "Average", "Top", "Lowest"],
    ...report.breakdown.map((a) => [
      a.title,
      a.typeName,
      a.maximumMarks,
      a.status,
      a.gradedCount,
      pct(a.average),
      a.top ? `${a.top.studentName} (${a.top.mark})` : "",
      a.lowest ? `${a.lowest.studentName} (${a.lowest.mark})` : "",
    ]),
  ];

  const base64 = buildWorkbookBase64([
    { name: "Students", rows: studentRows },
    { name: "Assessments", rows: assessmentRows },
  ]);
  return {
    base64,
    fileName: safeFileName(
      `${report.assignment.course.name}-${report.assignment.class.name}-${report.assignment.semester.name}`
    ),
  };
}

export async function exportClassReport(classId: string, semesterId: string) {
  await requirePermission("reports.view.all");
  const report = await getClassReport(classId, semesterId);
  if (!report) throw new Error("NOT_FOUND");

  const rows: CellValue[][] = [
    ["Course", "Lecturer", "Students", "Class Average %"],
    ...report.courses.map((c) => [
      c.courseName,
      c.lecturerName,
      c.studentCount,
      pct(c.classAverage),
    ]),
  ];

  const base64 = buildWorkbookBase64([{ name: "Courses", rows }]);
  return {
    base64,
    fileName: safeFileName(`${report.class.name}-${report.semester.name}`),
  };
}

export async function exportStudentReport(studentId: string) {
  await requirePermission("reports.view.all");
  const report = await getStudentReport(studentId);
  if (!report) throw new Error("NOT_FOUND");

  const rows: CellValue[][] = [
    ["Course", "Class", "Semester", "Status", "Earned", "Possible", "Percentage"],
    ...report.history.map((h) => [
      h.courseName,
      h.className,
      h.semesterName,
      h.status,
      h.earned,
      h.possible,
      pct(h.percentage),
    ]),
  ];

  const base64 = buildWorkbookBase64([{ name: "History", rows }]);
  return {
    base64,
    fileName: safeFileName(`${report.student.studentNo}-${report.student.fullName}`),
  };
}
