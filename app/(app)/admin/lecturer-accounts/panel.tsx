import { prisma } from "@/lib/db";
import { WHATSAPP_SETTINGS_ID } from "@/lib/whatsapp-notify";
import { credentialStoreConfigured } from "@/lib/credential-crypto";
import { LecturerAccountsClient, UNASSIGNED_VALUE } from "./lecturer-accounts-client";

export async function LecturerAccountsPanel({
  departmentId,
}: {
  departmentId?: string;
}) {
  const [departments, whatsapp, lecturers] = await Promise.all([
    prisma.department.findMany({
      where: { deletedAt: null },
      orderBy: { name: "asc" },
    }),
    prisma.whatsAppSettings.findUnique({ where: { id: WHATSAPP_SETTINGS_ID } }),
    departmentId
      ? prisma.lecturer.findMany({
          where: {
            departmentId: departmentId === UNASSIGNED_VALUE ? null : departmentId,
          },
          include: { user: true },
          orderBy: { fullName: "asc" },
        })
      : Promise.resolve([]),
  ]);

  // Lean, ciphertext-free shape for the client — the encrypted
  // pendingCredential never crosses to the browser, only a boolean saying
  // whether one exists.
  const rows = lecturers.map((l) => ({
    id: l.id,
    staffNo: l.staffNo,
    fullName: l.fullName,
    phoneNumber: l.phoneNumber,
    departmentId: l.departmentId,
    user: l.user
      ? {
          id: l.user.id,
          lockedUntil: l.user.lockedUntil,
          mustChangePw: l.user.mustChangePw,
          passwordSentAt: l.user.passwordSentAt,
        }
      : null,
    hasStoredCredential: !!l.user?.pendingCredential,
  }));

  return (
    <LecturerAccountsClient
      departments={departments}
      selectedDepartmentId={departmentId ?? ""}
      lecturers={rows}
      whatsappEnabled={!!whatsapp?.enabled}
      domainConfigured={!!whatsapp?.domainName}
      credentialStoreReady={credentialStoreConfigured()}
    />
  );
}
