import { prisma } from "@/lib/db";
import { WHATSAPP_SETTINGS_ID } from "@/lib/whatsapp-notify";
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

  return (
    <LecturerAccountsClient
      departments={departments}
      selectedDepartmentId={departmentId ?? ""}
      lecturers={lecturers}
      whatsappEnabled={!!whatsapp?.enabled}
      domainConfigured={!!whatsapp?.domainName}
    />
  );
}
