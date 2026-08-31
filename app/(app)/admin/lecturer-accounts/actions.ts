"use server";

import { randomBytes } from "crypto";
import argon2 from "argon2";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma, BULK_TRANSACTION_OPTIONS } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { audit } from "@/lib/audit";
import {
  WHATSAPP_SETTINGS_ID,
  sendLecturerCredentials as enqueueLecturerCredentialsMessage,
} from "@/lib/whatsapp-notify";
import { encryptCredential, decryptCredential } from "@/lib/credential-crypto";

function generateTempPassword(): string {
  return randomBytes(9).toString("base64url");
}

export interface GeneratedLecturerAccount {
  lecturerId: string;
  staffNo: string;
  fullName: string;
  phoneNumber: string;
  tempPassword: string;
}

// One transaction for the whole department: either every eligible
// lecturer (has a phoneNumber, no account yet) gets one, or none do.
// Mirrors generateAccountsForClass (admin/student-accounts/actions.ts) —
// same hash-before-transaction pattern (argon2id is deliberately slow;
// see CLAUDE.md's dedicated convention on this).
export async function generateAccountsForDepartment(
  departmentId: string | null
): Promise<{ created: GeneratedLecturerAccount[]; skippedNoPhone: number }> {
  const admin = await requirePermission("user.manage");

  const lecturers = await prisma.lecturer.findMany({
    where: { departmentId, userId: null },
  });
  const eligible = lecturers.filter((l) => !!l.phoneNumber);
  const skippedNoPhone = lecturers.length - eligible.length;
  if (eligible.length === 0) {
    return { created: [], skippedNoPhone };
  }

  const lecturerRole = await prisma.role.findUniqueOrThrow({
    where: { name: "LECTURER" },
  });

  const toCreate = await Promise.all(
    eligible.map(async (lecturer) => {
      const tempPassword = generateTempPassword();
      const passwordHash = await argon2.hash(tempPassword, {
        type: argon2.argon2id,
      });
      return {
        lecturer,
        tempPassword,
        passwordHash,
        // Encrypted at rest so "Send credentials" stays reachable from the
        // main table later — see lib/credential-crypto.ts. null if no key
        // is configured (the table entry point just degrades then).
        pendingCredential: encryptCredential(tempPassword),
      };
    })
  );

  const created: (GeneratedLecturerAccount & { userId: string })[] = [];

  await prisma.$transaction(async (tx) => {
    for (const { lecturer, tempPassword, passwordHash, pendingCredential } of toCreate) {
      const user = await tx.user.create({
        data: {
          username: lecturer.phoneNumber!,
          email: null,
          fullName: lecturer.fullName,
          passwordHash,
          mustChangePw: true,
          pendingCredential,
          userRoles: { create: { roleId: lecturerRole.id } },
        },
      });
      await tx.lecturer.update({
        where: { id: lecturer.id },
        data: { userId: user.id },
      });

      created.push({
        lecturerId: lecturer.id,
        staffNo: lecturer.staffNo,
        fullName: lecturer.fullName,
        phoneNumber: lecturer.phoneNumber!,
        tempPassword,
        userId: user.id,
      });
    }
  }, BULK_TRANSACTION_OPTIONS);

  for (const account of created) {
    await audit({
      userId: admin.id,
      action: "LECTURER_ACCOUNT_GENERATED",
      entity: "User",
      entityId: account.userId,
      newValue: { staffNo: account.staffNo, phoneNumber: account.phoneNumber },
    });
  }

  revalidatePath("/admin/lecturers");
  return {
    created: created.map(
      ({ lecturerId, staffNo, fullName, phoneNumber, tempPassword }) => ({
        lecturerId,
        staffNo,
        fullName,
        phoneNumber,
        tempPassword,
      })
    ),
    skippedNoPhone,
  };
}

export async function generateAccountForLecturer(
  lecturerId: string
): Promise<{ tempPassword: string }> {
  const admin = await requirePermission("user.manage");

  const lecturer = await prisma.lecturer.findUniqueOrThrow({
    where: { id: lecturerId },
  });
  if (lecturer.userId) {
    throw new Error("ALREADY_HAS_ACCOUNT");
  }
  if (!lecturer.phoneNumber) {
    throw new Error("NO_PHONE_NUMBER");
  }

  const tempPassword = generateTempPassword();
  const passwordHash = await argon2.hash(tempPassword, {
    type: argon2.argon2id,
  });

  const lecturerRole = await prisma.role.findUniqueOrThrow({
    where: { name: "LECTURER" },
  });

  let user;
  try {
    user = await prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          username: lecturer.phoneNumber!,
          email: null,
          fullName: lecturer.fullName,
          passwordHash,
          mustChangePw: true,
          pendingCredential: encryptCredential(tempPassword),
          userRoles: { create: { roleId: lecturerRole.id } },
        },
      });
      await tx.lecturer.update({
        where: { id: lecturer.id },
        data: { userId: newUser.id },
      });
      return newUser;
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new Error("PHONE_NUMBER_TAKEN");
    }
    throw error;
  }

  await audit({
    userId: admin.id,
    action: "LECTURER_ACCOUNT_GENERATED",
    entity: "User",
    entityId: user.id,
    newValue: { staffNo: lecturer.staffNo, phoneNumber: lecturer.phoneNumber },
  });

  revalidatePath("/admin/lecturers");
  return { tempPassword };
}

export async function resetLecturerPassword(
  lecturerId: string
): Promise<{ tempPassword: string }> {
  const admin = await requirePermission("user.manage");

  const lecturer = await prisma.lecturer.findUniqueOrThrow({
    where: { id: lecturerId },
  });
  if (!lecturer.userId) {
    throw new Error("NO_ACCOUNT");
  }

  const tempPassword = generateTempPassword();
  const passwordHash = await argon2.hash(tempPassword, {
    type: argon2.argon2id,
  });

  await prisma.user.update({
    where: { id: lecturer.userId },
    data: {
      passwordHash,
      mustChangePw: true,
      failedLogins: 0,
      lockedUntil: null,
      // A fresh temp password is "un-sent" again — so "Send credentials"
      // becomes available for it without needing the resend override.
      passwordSentAt: null,
      // ...and it's the one that's now sendable from the persistent table.
      pendingCredential: encryptCredential(tempPassword),
    },
  });

  await audit({
    userId: admin.id,
    action: "LECTURER_PASSWORD_RESET",
    entity: "User",
    entityId: lecturer.userId,
    newValue: { staffNo: lecturer.staffNo },
  });

  revalidatePath("/admin/lecturers");
  return { tempPassword };
}

// ============================================================
// "Send credentials" — a SEPARATE, explicit action from account
// generation. Fills the LECTURER_LOGIN_CREDENTIALS WhatsApp template with
// a lecturer's real username + their current temp password, their
// faculty, the active academic year/semester, and the configured login
// domain — then enqueues it via the same lib/whatsapp-notify path every
// other notification uses. Marks the password "sent" so it can't be
// re-sent by accident.
//
// The temp password comes from EITHER the client (the still-open
// post-generation results dialog, which holds it in memory) OR — for the
// PERSISTENT entry point on the main Lecturer Accounts table — the
// encrypted-at-rest User.pendingCredential (lib/credential-crypto.ts),
// decrypted here server-side. That's what lets an admin re-send the SAME
// still-valid credential anytime without a password reset.
// ============================================================

const sendCredentialsSchema = z.object({
  lecturerId: z.string().min(1),
  // Optional: supplied by the post-generation popup (in-memory). Omitted
  // by the persistent table entry point, which falls back to the stored
  // encrypted credential.
  tempPassword: z.string().min(1).optional(),
  // Explicit override for the "already sent" guard (requirement 5 —
  // lecturer lost the message before changing their password). Never
  // overrides PASSWORD_CHANGED — once they've changed it, the temp
  // password is stale and Reset Password is the only correct path.
  force: z.boolean().optional(),
});

const sendCredentialsBatchSchema = z.object({
  items: z
    .array(
      z.object({
        lecturerId: z.string().min(1),
        tempPassword: z.string().min(1).optional(),
      })
    )
    .min(1),
  force: z.boolean().optional(),
});

export type SendCredentialsStatus =
  | "sent"
  | "already_sent"
  | "password_changed"
  | "no_phone_or_disabled"
  | "no_account"
  // No client-supplied password AND no decryptable stored credential
  // (account predates this feature, or no encryption key configured).
  | "no_stored_credential";

const LECTURER_SEND_SELECT = {
  id: true,
  staffNo: true,
  fullName: true,
  phoneNumber: true,
  user: {
    select: {
      id: true,
      username: true,
      mustChangePw: true,
      passwordSentAt: true,
      pendingCredential: true,
    },
  },
  department: { select: { name: true } },
  assignments: {
    select: {
      class: {
        select: { program: { select: { department: { select: { name: true } } } } },
      },
    },
    take: 10,
  },
} satisfies Prisma.LecturerSelect;

type LecturerForSend = Prisma.LecturerGetPayload<{ select: typeof LECTURER_SEND_SELECT }>;

// Faculty for the {facultyName} placeholder: the lecturer's own
// registered home department first, else the department of any class
// they're currently assigned to teach (via program), else blank.
function resolveFacultyName(lecturer: LecturerForSend): string {
  if (lecturer.department?.name) return lecturer.department.name;
  for (const a of lecturer.assignments) {
    if (a.class.program.department.name) return a.class.program.department.name;
  }
  return "";
}

// The bits of the message that are the same for every lecturer in a
// send — resolved once per action call, not per lecturer.
async function resolveCredentialsContext() {
  const [settings, semester] = await Promise.all([
    prisma.whatsAppSettings.findUnique({ where: { id: WHATSAPP_SETTINGS_ID } }),
    prisma.semester.findFirst({
      where: { isActive: true },
      include: { academicYear: true },
    }),
  ]);
  return {
    domainName: settings?.domainName ?? "",
    academicYear: semester?.academicYear.name ?? "",
    semesterName: semester?.name ?? "",
  };
}

// null = clear to send. A hard block ("password_changed") stays a block
// even with force; a soft block ("already_sent") is cleared by force.
function credentialsSendBlock(
  user: { mustChangePw: boolean; passwordSentAt: Date | null },
  force: boolean | undefined
): "already_sent" | "password_changed" | null {
  if (!user.mustChangePw) return "password_changed";
  if (user.passwordSentAt && !force) return "already_sent";
  return null;
}

// The effective temp password to send: whatever the caller supplied
// (popup, in-memory) or the decrypted stored credential (persistent
// table). null when neither is available.
function resolveTempPassword(
  lecturer: LecturerForSend,
  clientSupplied: string | undefined
): string | null {
  if (clientSupplied) return clientSupplied;
  return decryptCredential(lecturer.user?.pendingCredential ?? null);
}

async function deliverCredentials(
  adminId: string,
  lecturer: LecturerForSend,
  tempPassword: string,
  ctx: Awaited<ReturnType<typeof resolveCredentialsContext>>
): Promise<SendCredentialsStatus> {
  if (!lecturer.user) return "no_account";

  const { enqueued } = await enqueueLecturerCredentialsMessage({
    lecturerId: lecturer.id,
    lecturerName: lecturer.fullName,
    phoneNumber: lecturer.phoneNumber,
    userId: lecturer.user.id,
    username: lecturer.user.username,
    tempPassword,
    facultyName: resolveFacultyName(lecturer),
    academicYear: ctx.academicYear,
    semesterName: ctx.semesterName,
    domainName: ctx.domainName,
  });

  // Nothing actually left the app (no phone on file, or the whole
  // feature is off) — don't flag the password as sent, so the admin can
  // retry after fixing the cause without needing the resend override.
  if (!enqueued) return "no_phone_or_disabled";

  await prisma.user.update({
    where: { id: lecturer.user.id },
    data: { passwordSentAt: new Date() },
  });

  await audit({
    userId: adminId,
    action: "LECTURER_CREDENTIALS_SENT",
    entity: "User",
    entityId: lecturer.user.id,
    newValue: {
      lecturerId: lecturer.id,
      staffNo: lecturer.staffNo,
      resent: lecturer.user.passwordSentAt !== null,
      sentAt: new Date().toISOString(),
    },
  });

  return "sent";
}

export async function sendLecturerCredentials(
  input: z.input<typeof sendCredentialsSchema>
): Promise<{ status: SendCredentialsStatus }> {
  const admin = await requirePermission("user.manage");
  const { lecturerId, tempPassword, force } = sendCredentialsSchema.parse(input);

  const ctx = await resolveCredentialsContext();
  if (!ctx.domainName) throw new Error("DOMAIN_NOT_CONFIGURED");

  const lecturer = await prisma.lecturer.findUniqueOrThrow({
    where: { id: lecturerId },
    select: LECTURER_SEND_SELECT,
  });
  if (!lecturer.user) throw new Error("NO_ACCOUNT");

  const block = credentialsSendBlock(lecturer.user, force);
  if (block === "password_changed") throw new Error("PASSWORD_CHANGED");
  if (block === "already_sent") throw new Error("ALREADY_SENT");

  const effectivePassword = resolveTempPassword(lecturer, tempPassword);
  if (!effectivePassword) throw new Error("NO_STORED_CREDENTIAL");

  const status = await deliverCredentials(admin.id, lecturer, effectivePassword, ctx);

  revalidatePath("/admin/lecturers");
  return { status };
}

export async function sendLecturerCredentialsBatch(
  input: z.input<typeof sendCredentialsBatchSchema>
): Promise<{
  results: {
    lecturerId: string;
    staffNo: string;
    fullName: string;
    status: SendCredentialsStatus;
  }[];
}> {
  const admin = await requirePermission("user.manage");
  const { items, force } = sendCredentialsBatchSchema.parse(input);

  const ctx = await resolveCredentialsContext();
  if (!ctx.domainName) throw new Error("DOMAIN_NOT_CONFIGURED");

  const suppliedById = new Map(items.map((i) => [i.lecturerId, i.tempPassword]));
  const lecturers = await prisma.lecturer.findMany({
    where: { id: { in: [...suppliedById.keys()] } },
    select: LECTURER_SEND_SELECT,
  });

  const results: {
    lecturerId: string;
    staffNo: string;
    fullName: string;
    status: SendCredentialsStatus;
  }[] = [];

  for (const lecturer of lecturers) {
    let status: SendCredentialsStatus;
    if (!lecturer.user) {
      status = "no_account";
    } else {
      const block = credentialsSendBlock(lecturer.user, force);
      if (block) {
        status = block;
      } else {
        const effectivePassword = resolveTempPassword(
          lecturer,
          suppliedById.get(lecturer.id) ?? undefined
        );
        status = effectivePassword
          ? await deliverCredentials(admin.id, lecturer, effectivePassword, ctx)
          : "no_stored_credential";
      }
    }
    results.push({
      lecturerId: lecturer.id,
      staffNo: lecturer.staffNo,
      fullName: lecturer.fullName,
      status,
    });
  }

  revalidatePath("/admin/lecturers");
  return { results };
}
