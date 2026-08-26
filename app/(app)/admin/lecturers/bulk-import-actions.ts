"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma, BULK_TRANSACTION_OPTIONS } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { PHONE_NUMBER_PATTERN } from "@/lib/whatsapp-notify";
import {
  parseSpreadsheet,
  assertFileSize,
  assertRowCount,
} from "@/lib/import/parse";
import { buildTemplateBase64 } from "@/lib/import/template";
import type { ImportPreviewResult, ImportRowResult } from "@/lib/import/types";

export interface LecturerImportRow {
  staffNo: string;
  fullName: string;
  phoneNumber: string;
  departmentId: string | null;
}

const TEMPLATE_COLUMNS = [
  { header: "staff_no", example1: "L001", example2: "L002" },
  { header: "full_name", example1: "Dr. Amina Yusuf", example2: "Eng. Omar Ali" },
  { header: "phone_number", example1: "2526XXXXXXX1", example2: "2526XXXXXXX2" },
  { header: "department", example1: "CS", example2: "Business" },
];

export async function downloadLecturerImportTemplate() {
  await requirePermission("user.manage");
  return {
    base64: buildTemplateBase64(TEMPLATE_COLUMNS, "Lecturers"),
    fileName: "lecturers-import-template.xlsx",
  };
}

// Custom preview (not lib/import/preview.ts's generic buildPreview, which
// only supports ONE dedup key) — a lecturer row has TWO independently
// unique identifiers, staff_no and phone_number, either of which can
// individually collide within the file or against the DB. Same
// four-status shape (OK / DUPLICATE_IN_FILE / ALREADY_EXISTS / ERROR) as
// every other bulk import in this app, same pattern the old lecturer
// import in admin/users/bulk-import-actions.ts already used for
// staff_no+email before this move.
export async function previewLecturerImport(
  formData: FormData
): Promise<ImportPreviewResult<LecturerImportRow>> {
  await requirePermission("user.manage");

  const file = formData.get("file");
  if (!(file instanceof File)) {
    throw new Error("NO_FILE");
  }
  assertFileSize(file.size);

  const buffer = await file.arrayBuffer();
  const { rows } = parseSpreadsheet(buffer);
  assertRowCount(rows.length);

  const [existingLecturers, departments] = await Promise.all([
    prisma.lecturer.findMany({ select: { staffNo: true, phoneNumber: true } }),
    prisma.department.findMany({ where: { deletedAt: null } }),
  ]);
  const existingStaffNos = new Set(
    existingLecturers.map((l) => l.staffNo.trim().toLowerCase())
  );
  const existingPhoneNumbers = new Set(
    existingLecturers
      .map((l) => l.phoneNumber?.trim().toLowerCase())
      .filter((p): p is string => !!p)
  );
  const departmentsByCode = new Map(
    departments.map((d) => [d.code.trim().toLowerCase(), d])
  );
  const departmentsByName = new Map(
    departments.map((d) => [d.name.trim().toLowerCase(), d])
  );

  interface Parsed {
    rowNumber: number;
    display: Record<string, string>;
    staffNo: string;
    phoneNumber: string;
    error: string | null;
    data: LecturerImportRow | null;
  }

  const phoneSchema = z.string().regex(PHONE_NUMBER_PATTERN);

  const parsed: Parsed[] = rows.map((row) => {
    const staffNo = (row.cells["staff_no"] ?? "").trim();
    const fullName = (row.cells["full_name"] ?? "").trim();
    const phoneNumber = (row.cells["phone_number"] ?? "").trim();
    const departmentCell = (row.cells["department"] ?? "").trim();

    const display = {
      staff_no: staffNo,
      full_name: fullName,
      phone_number: phoneNumber,
      department: departmentCell,
    };

    const issues: string[] = [];
    if (!staffNo) issues.push("Missing staff_no");
    if (!fullName) issues.push("Missing full_name");
    if (!phoneNumber) {
      issues.push("Missing phone_number");
    } else if (!phoneSchema.safeParse(phoneNumber).success) {
      // A leading "+" is accepted but never required — real data is
      // plain digits (country code + number), matching
      // PHONE_NUMBER_PATTERN.
      issues.push(
        `Invalid phone_number "${phoneNumber}" (expected 8-15 digits, e.g. 2526XXXXXXXX — a leading "+" is optional)`
      );
    }

    let departmentId: string | null = null;
    if (departmentCell) {
      const match =
        departmentsByCode.get(departmentCell.toLowerCase()) ??
        departmentsByName.get(departmentCell.toLowerCase());
      if (!match) {
        issues.push(`Unknown department "${departmentCell}"`);
      } else {
        departmentId = match.id;
      }
    }

    if (issues.length > 0) {
      return {
        rowNumber: row.rowNumber,
        display,
        staffNo: staffNo.toLowerCase(),
        phoneNumber: phoneNumber.toLowerCase(),
        error: issues.join("; "),
        data: null,
      };
    }

    return {
      rowNumber: row.rowNumber,
      display,
      staffNo: staffNo.toLowerCase(),
      phoneNumber: phoneNumber.toLowerCase(),
      error: null,
      data: { staffNo, fullName, phoneNumber, departmentId },
    };
  });

  const staffNoCounts = new Map<string, number>();
  const phoneCounts = new Map<string, number>();
  for (const p of parsed) {
    if (p.error) continue;
    staffNoCounts.set(p.staffNo, (staffNoCounts.get(p.staffNo) ?? 0) + 1);
    phoneCounts.set(p.phoneNumber, (phoneCounts.get(p.phoneNumber) ?? 0) + 1);
  }

  const resultRows: ImportRowResult<LecturerImportRow>[] = parsed.map((p) => {
    if (p.error) {
      return {
        rowNumber: p.rowNumber,
        status: "ERROR",
        reason: p.error,
        display: p.display,
        data: null,
      };
    }
    const dupStaffNo = (staffNoCounts.get(p.staffNo) ?? 0) > 1;
    const dupPhone = (phoneCounts.get(p.phoneNumber) ?? 0) > 1;
    if (dupStaffNo || dupPhone) {
      return {
        rowNumber: p.rowNumber,
        status: "DUPLICATE_IN_FILE",
        reason:
          dupStaffNo && dupPhone
            ? "Same staff_no and phone_number appear more than once in this file"
            : dupStaffNo
              ? "Same staff_no appears more than once in this file"
              : "Same phone_number appears more than once in this file",
        display: p.display,
        data: null,
      };
    }
    if (existingStaffNos.has(p.staffNo) || existingPhoneNumbers.has(p.phoneNumber)) {
      return {
        rowNumber: p.rowNumber,
        status: "ALREADY_EXISTS",
        reason: "Already exists — will be skipped",
        display: p.display,
        data: null,
      };
    }
    return {
      rowNumber: p.rowNumber,
      status: "OK",
      reason: null,
      display: p.display,
      data: p.data,
    };
  });

  return {
    rows: resultRows,
    counts: {
      ok: resultRows.filter((r) => r.status === "OK").length,
      duplicate: resultRows.filter((r) => r.status === "DUPLICATE_IN_FILE").length,
      alreadyExists: resultRows.filter((r) => r.status === "ALREADY_EXISTS").length,
      error: resultRows.filter((r) => r.status === "ERROR").length,
    },
  };
}

const confirmRowSchema = z.object({
  staffNo: z.string().trim().min(1),
  fullName: z.string().trim().min(1),
  phoneNumber: z.string().trim().regex(PHONE_NUMBER_PATTERN),
  departmentId: z.string().trim().nullable(),
});
const confirmSchema = z.array(confirmRowSchema);

export async function confirmLecturerImport(
  input: LecturerImportRow[],
  fileName: string
): Promise<{ created: number }> {
  const admin = await requirePermission("user.manage");
  const rows = confirmSchema.parse(input);
  if (rows.length === 0) return { created: 0 };

  // Re-check right before the transaction for the same reason as every
  // other bulk import: Postgres aborts the whole transaction on the first
  // failed statement, so conflicts must be filtered out before any
  // create() runs, never caught mid-loop.
  const existing = await prisma.lecturer.findMany({
    where: {
      OR: [
        { staffNo: { in: rows.map((r) => r.staffNo) } },
        { phoneNumber: { in: rows.map((r) => r.phoneNumber) } },
      ],
    },
    select: { staffNo: true, phoneNumber: true },
  });
  const existingStaffNos = new Set(
    existing.map((l) => l.staffNo.trim().toLowerCase())
  );
  const existingPhoneNumbers = new Set(
    existing
      .map((l) => l.phoneNumber?.trim().toLowerCase())
      .filter((p): p is string => !!p)
  );
  const toCreate = rows.filter(
    (r) =>
      !existingStaffNos.has(r.staffNo.trim().toLowerCase()) &&
      !existingPhoneNumbers.has(r.phoneNumber.trim().toLowerCase())
  );

  const created = await prisma.$transaction(async (tx) => {
    let count = 0;
    for (const row of toCreate) {
      await tx.lecturer.create({
        data: {
          staffNo: row.staffNo,
          fullName: row.fullName,
          phoneNumber: row.phoneNumber,
          departmentId: row.departmentId,
        },
      });
      count++;
    }
    return count;
  }, BULK_TRANSACTION_OPTIONS);

  await audit({
    userId: admin.id,
    action: "BULK_IMPORT",
    entity: "Lecturer",
    newValue: {
      entityType: "Lecturer",
      fileName,
      requested: rows.length,
      created,
      skipped: rows.length - created,
    },
  });

  revalidatePath("/admin/lecturers");
  return { created };
}
