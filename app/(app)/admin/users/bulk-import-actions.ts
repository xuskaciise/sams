"use server";

import { randomBytes } from "crypto";
import argon2 from "argon2";
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
import type { ImportPreviewResult, ImportRowResult } from "@/lib/import/types";

export interface LecturerImportRow {
  staffNo: string;
  fullName: string;
  email: string;
}

export interface GeneratedLecturerAccount {
  staffNo: string;
  fullName: string;
  email: string;
  tempPassword: string;
}

const TEMPLATE_COLUMNS = [
  { header: "staff_no", example1: "L001", example2: "L002" },
  { header: "full_name", example1: "Dr. Amina Yusuf", example2: "Eng. Omar Ali" },
  {
    header: "email",
    example1: "amina.yusuf@university.edu",
    example2: "omar.ali@university.edu",
  },
];

function generateTempPassword(): string {
  return randomBytes(9).toString("base64url");
}

export async function downloadLecturerImportTemplate() {
  await requirePermission("user.manage");
  return {
    base64: buildTemplateBase64(TEMPLATE_COLUMNS, "Lecturers"),
    fileName: "lecturers-import-template.xlsx",
  };
}

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

  const existingLecturers = await prisma.lecturer.findMany({
    select: { staffNo: true },
  });
  const existingStaffNos = new Set(
    existingLecturers.map((l) => l.staffNo.trim().toLowerCase())
  );
  const existingUsers = await prisma.user.findMany({
    select: { email: true },
  });
  const existingEmails = new Set(
    existingUsers.map((u) => u.email.trim().toLowerCase())
  );

  interface Parsed {
    rowNumber: number;
    display: Record<string, string>;
    staffNo: string;
    email: string;
    error: string | null;
    data: LecturerImportRow | null;
  }

  const emailSchema = z.string().trim().email();

  const parsed: Parsed[] = rows.map((row) => {
    const staffNo = (row.cells["staff_no"] ?? "").trim();
    const fullName = (row.cells["full_name"] ?? "").trim();
    const emailRaw = (row.cells["email"] ?? "").trim();

    const display = {
      staff_no: staffNo,
      full_name: fullName,
      email: emailRaw,
    };

    const issues: string[] = [];
    if (!staffNo) issues.push("Missing staff_no");
    if (!fullName) issues.push("Missing full_name");
    if (!emailRaw) {
      issues.push("Missing email");
    } else if (!emailSchema.safeParse(emailRaw).success) {
      issues.push(`Invalid email "${emailRaw}"`);
    }

    if (issues.length > 0) {
      return {
        rowNumber: row.rowNumber,
        display,
        staffNo: staffNo.toLowerCase(),
        email: emailRaw.toLowerCase(),
        error: issues.join("; "),
        data: null,
      };
    }

    return {
      rowNumber: row.rowNumber,
      display,
      staffNo: staffNo.toLowerCase(),
      email: emailRaw.toLowerCase(),
      error: null,
      data: { staffNo, fullName, email: emailRaw.toLowerCase() },
    };
  });

  const staffNoCounts = new Map<string, number>();
  const emailCounts = new Map<string, number>();
  for (const p of parsed) {
    if (p.error) continue;
    staffNoCounts.set(p.staffNo, (staffNoCounts.get(p.staffNo) ?? 0) + 1);
    emailCounts.set(p.email, (emailCounts.get(p.email) ?? 0) + 1);
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
    const dupEmail = (emailCounts.get(p.email) ?? 0) > 1;
    if (dupStaffNo || dupEmail) {
      return {
        rowNumber: p.rowNumber,
        status: "DUPLICATE_IN_FILE",
        reason: dupStaffNo && dupEmail
          ? "Same staff_no and email appear more than once in this file"
          : dupStaffNo
            ? "Same staff_no appears more than once in this file"
            : "Same email appears more than once in this file",
        display: p.display,
        data: null,
      };
    }
    if (existingStaffNos.has(p.staffNo) || existingEmails.has(p.email)) {
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
  email: z.string().trim().email(),
});
const confirmSchema = z.array(confirmRowSchema);

export async function confirmLecturerImport(
  input: LecturerImportRow[],
  fileName: string
): Promise<{ created: GeneratedLecturerAccount[] }> {
  const admin = await requirePermission("user.manage");
  const rows = confirmSchema.parse(input);
  if (rows.length === 0) return { created: [] };

  // Re-check right before the transaction for the same reason as the other
  // bulk imports: Postgres aborts the whole transaction on the first failed
  // statement, so conflicts must be filtered out before any create() runs.
  const existingLecturers = await prisma.lecturer.findMany({
    where: { staffNo: { in: rows.map((r) => r.staffNo) } },
    select: { staffNo: true },
  });
  const existingStaffNos = new Set(
    existingLecturers.map((l) => l.staffNo.trim().toLowerCase())
  );
  const existingUsers = await prisma.user.findMany({
    where: { email: { in: rows.map((r) => r.email) } },
    select: { email: true },
  });
  const existingEmails = new Set(
    existingUsers.map((u) => u.email.trim().toLowerCase())
  );
  const toCreate = rows.filter(
    (r) =>
      !existingStaffNos.has(r.staffNo.trim().toLowerCase()) &&
      !existingEmails.has(r.email.trim().toLowerCase())
  );

  const created: (GeneratedLecturerAccount & { userId: string })[] = [];
  const lecturerRole = await prisma.role.findUniqueOrThrow({
    where: { name: "LECTURER" },
  });

  await prisma.$transaction(async (tx) => {
    for (const row of toCreate) {
      const tempPassword = generateTempPassword();
      const passwordHash = await argon2.hash(tempPassword, {
        type: argon2.argon2id,
      });
      const user = await tx.user.create({
        data: {
          username: row.email,
          email: row.email,
          fullName: row.fullName,
          passwordHash,
          mustChangePw: true,
          userRoles: { create: { roleId: lecturerRole.id } },
        },
      });
      await tx.lecturer.create({
        data: { userId: user.id, staffNo: row.staffNo, title: null },
      });
      created.push({
        staffNo: row.staffNo,
        fullName: row.fullName,
        email: row.email,
        tempPassword,
        userId: user.id,
      });
    }
  });

  await audit({
    userId: admin.id,
    action: "BULK_IMPORT",
    entity: "User",
    newValue: {
      entityType: "Lecturer",
      fileName,
      requested: rows.length,
      created: created.length,
      skipped: rows.length - created.length,
    },
  });
  for (const account of created) {
    await audit({
      userId: admin.id,
      action: "USER_CREATED",
      entity: "User",
      entityId: account.userId,
      newValue: { email: account.email, role: "LECTURER" },
    });
  }

  revalidatePath("/admin/users");
  return {
    created: created.map(({ staffNo, fullName, email, tempPassword }) => ({
      staffNo,
      fullName,
      email,
      tempPassword,
    })),
  };
}
