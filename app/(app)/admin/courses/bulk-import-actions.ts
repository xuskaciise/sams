"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { audit } from "@/lib/audit";
import {
  parseSpreadsheet,
  assertFileSize,
  assertRowCount,
} from "@/lib/import/parse";
import { buildTemplateBase64 } from "@/lib/import/template";
import { buildPreview, type RowValidation } from "@/lib/import/preview";
import type { ImportPreviewResult } from "@/lib/import/types";

export interface CourseImportRow {
  code: string;
  name: string;
}

const TEMPLATE_COLUMNS = [
  { header: "course_code", example1: "CS201", example2: "CS202" },
  {
    header: "course_name",
    example1: "Data Structures",
    example2: "Web Development II",
  },
];

export async function downloadCourseImportTemplate() {
  await requirePermission("curriculum.manage");
  return {
    base64: buildTemplateBase64(TEMPLATE_COLUMNS, "Courses"),
    fileName: "courses-import-template.xlsx",
  };
}

export async function previewCourseImport(
  formData: FormData
): Promise<ImportPreviewResult<CourseImportRow>> {
  await requirePermission("curriculum.manage");

  const file = formData.get("file");
  if (!(file instanceof File)) {
    throw new Error("NO_FILE");
  }
  assertFileSize(file.size);

  const buffer = await file.arrayBuffer();
  const { rows } = parseSpreadsheet(buffer);
  assertRowCount(rows.length);

  const existingCourses = await prisma.course.findMany({
    select: { code: true },
  });
  const existingKeys = new Set(
    existingCourses.map((c) => c.code.trim().toLowerCase())
  );

  const validations: RowValidation<CourseImportRow>[] = rows.map((row) => {
    const code = (row.cells["course_code"] ?? "").trim().toUpperCase();
    const name = (row.cells["course_name"] ?? "").trim();

    const display = {
      course_code: row.cells["course_code"] ?? "",
      course_name: name,
    };

    const issues: string[] = [];
    if (!code) issues.push("Missing course_code");
    if (!name) issues.push("Missing course_name");

    if (issues.length > 0) {
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
      key: code.toLowerCase(),
      error: null,
      data: { code, name },
    };
  });

  return buildPreview(validations, existingKeys);
}

const confirmRowSchema = z.object({
  code: z.string().trim().min(1),
  name: z.string().trim().min(1),
});
const confirmSchema = z.array(confirmRowSchema);

export async function confirmCourseImport(
  input: CourseImportRow[],
  fileName: string
): Promise<{ created: number }> {
  const admin = await requirePermission("curriculum.manage");
  const rows = confirmSchema.parse(input);
  if (rows.length === 0) return { created: 0 };

  const existing = await prisma.course.findMany({
    where: { code: { in: rows.map((r) => r.code) } },
    select: { code: true },
  });
  const existingKeys = new Set(
    existing.map((c) => c.code.trim().toLowerCase())
  );
  const toCreate = rows.filter(
    (r) => !existingKeys.has(r.code.trim().toLowerCase())
  );

  await prisma.$transaction(
    toCreate.map((row) =>
      prisma.course.create({ data: { code: row.code, name: row.name } })
    )
  );

  await audit({
    userId: admin.id,
    action: "BULK_IMPORT",
    entity: "Course",
    newValue: {
      entityType: "Course",
      fileName,
      requested: rows.length,
      created: toCreate.length,
      skipped: rows.length - toCreate.length,
    },
  });

  revalidatePath("/admin/curriculum");
  return { created: toCreate.length };
}
