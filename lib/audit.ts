import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";

interface AuditParams {
  userId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  oldValue?: Prisma.InputJsonValue;
  newValue?: Prisma.InputJsonValue;
  ipAddress?: string | null;
}

export async function audit(params: AuditParams): Promise<void> {
  await prisma.auditLog.create({
    data: {
      userId: params.userId ?? null,
      action: params.action,
      entity: params.entity,
      entityId: params.entityId ?? null,
      oldValue: params.oldValue,
      newValue: params.newValue,
      ipAddress: params.ipAddress ?? null,
    },
  });
}
