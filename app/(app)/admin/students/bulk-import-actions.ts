"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { Gender } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { audit } from "@/lib/audit";
import {
  autoEnrollStudentIntoClassCourses,
  auditAutoEnrollments,
  type AutoEnrolledRecord,
} from "@/lib/enrollment";
import {
  parseSpreadsheet,
  assertFileSize,
  assertRowCount,
} from "@/lib/import/parse";
import { buildTemplateBase64 } from "@/lib/import/template";
import { buildPreview, type RowValidation } from "@/lib/import/preview";
import type { ImportPreviewResult } from "@/lib/import/types";

export interface StudentImportRow {
  studentNo: string;
  fullName: string;
  gender: Gender;
  classId: string;
}

const TEMPLATE_COLUMNS = [
  { header: "student_no", example1: "S1001", example2: "S1002" },
  { header: "full_name", example1: "Jane Doe", example2: "John Smith" },
  { header: "gender", example1: "FEMALE", example2: "MALE" },
  { header: "class_code", example1: "CS-Year2-A", example2: "CS-Year2-A" },
];

export async function downloadStudentImportTemplate() {
  await requirePermission("students.manage");
  return {
    base64: buildTemplateBase64(TEMPLATE_COLUMNS, "Students"),
    fileName: "students-import-template.xlsx",
  };
}

export async function previewStudentImport(
  formData: FormData
): Promise<ImportPreviewResult<StudentImportRow>> {
  await requirePermission("students.manage");

  const file = formData.get("file");
  if (!(file instanceof File)) {
    throw new Error("NO_FILE");
  }
  assertFileSize(file.size);

  const buffer = await file.arrayBuffer();
  const { rows } = parseSpreadsheet(buffer);
  assertRowCount(rows.length);

  const classes = await prisma.class.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, program: { select: { code: true } } },
  });
  const classesByName = new Map<string, typeof classes>();
  for (const cls of classes) {
    const key = cls.name.trim().toLowerCase();
    classesByName.set(key, [...(classesByName.get(key) ?? []), cls]);
  }

  const existingStudents = await prisma.student.findMany({
    select: { studentNo: true },
  });
  const existingKeys = new Set(
    existingStudents.map((s) => s.studentNo.trim().toLowerCase())
  );

  const validations: RowValidation<StudentImportRow>[] = rows.map((row) => {
    const studentNo = (row.cells["student_no"] ?? "").trim();
    const fullName = (row.cells["full_name"] ?? "").trim();
    const genderRaw = (row.cells["gender"] ?? "").trim().toUpperCase();
    const classCode = (row.cells["class_code"] ?? "").trim();

    const display = {
      student_no: studentNo,
      full_name: fullName,
      gender: row.cells["gender"] ?? "",
      class_code: classCode,
    };

    const issues: string[] = [];
    if (!studentNo) issues.push("Missing student_no");
    if (!fullName) issues.push("Missing full_name");
    if (!genderRaw) {
      issues.push("Missing gender");
    } else if (genderRaw !== "MALE" && genderRaw !== "FEMALE") {
      issues.push(
        `Invalid gender "${row.cells["gender"]}" (expected MALE or FEMALE)`
      );
    }

    let classId: string | null = null;
    if (!classCode) {
      issues.push("Missing class_code");
    } else {
      const matches = classesByName.get(classCode.toLowerCase()) ?? [];
      if (matches.length === 0) {
        issues.push(`Unknown class_code "${classCode}"`);
      } else if (matches.length > 1) {
        issues.push(
          `Ambiguous class_code "${classCode}" — matches classes in programs ${matches
            .map((m) => m.program.code)
            .join(", ")}`
        );
      } else {
        classId = matches[0].id;
      }
    }

    if (issues.length > 0 || !classId) {
      return {
        rowNumber: row.rowNumber,
        display,
        key: null,
        error: issues.join("; "),
        data: null,
      };
    }

    return {
      rowNumber: row.rowNumber,
      display,
      key: studentNo.toLowerCase(),
      error: null,
      data: {
        studentNo,
        fullName,
        gender: genderRaw as Gender,
        classId,
      },
    };
  });

  return buildPreview(validations, existingKeys);
}

const confirmRowSchema = z.object({
  studentNo: z.string().trim().min(1),
  fullName: z.string().trim().min(1),
  gender: z.enum(["MALE", "FEMALE"]),
  classId: z.string().min(1),
});
const confirmSchema = z.array(confirmRowSchema);

export async function confirmStudentImport(
  input: StudentImportRow[],
  fileName: string
): Promise<{ created: number }> {
  const admin = await requirePermission("students.manage");
  const rows = confirmSchema.parse(input);
  if (rows.length === 0) return { created: 0 };

  // Re-check right before the transaction: time may have passed since
  // preview, and Postgres aborts the whole transaction on the first failed
  // statement, so anything that now conflicts must be filtered out before
  // any create() runs — never caught mid-loop. See CLAUDE.md conventions.
  const existing = await prisma.student.findMany({
    where: { studentNo: { in: rows.map((r) => r.studentNo) } },
    select: { studentNo: true },
  });
  const existingKeys = new Set(
    existing.map((s) => s.studentNo.trim().toLowerCase())
  );
  const toCreate = rows.filter(
    (r) => !existingKeys.has(r.studentNo.trim().toLowerCase())
  );

  const autoEnrolled: AutoEnrolledRecord[] = [];
  let created = 0;

  await prisma.$transaction(async (tx) => {
    for (const row of toCreate) {
      const student = await tx.student.create({
        data: {
          studentNo: row.studentNo,
          fullName: row.fullName,
          gender: row.gender,
          classId: row.classId,
        },
      });
      created++;
      const enrolled = await autoEnrollStudentIntoClassCourses(
        tx,
        student.id,
        student.classId
      );
      autoEnrolled.push(...enrolled);
    }
  });

  await audit({
    userId: admin.id,
    action: "BULK_IMPORT",
    entity: "Student",
    newValue: {
      entityType: "Student",
      fileName,
      requested: rows.length,
      created,
      skipped: rows.length - created,
    },
  });
  await auditAutoEnrollments(admin.id, autoEnrolled);

  revalidatePath("/admin/students");
  return { created };
}
