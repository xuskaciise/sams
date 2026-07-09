import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { resolvePageParams } from "@/lib/pagination";
import { AuditLogsClient } from "./audit-logs-client";

export interface AuditLogsSearchParams {
  entity?: string;
  q?: string;
  page?: string;
  pageSize?: string;
}

export async function AuditLogsPanel({
  searchParams,
}: {
  searchParams: AuditLogsSearchParams;
}) {
  const { page, pageSize, skip, take } = resolvePageParams(searchParams, 25);

  const where: Prisma.AuditLogWhereInput = {
    ...(searchParams.entity ? { entity: searchParams.entity } : {}),
    ...(searchParams.q
      ? {
          OR: [
            { action: { contains: searchParams.q, mode: "insensitive" } },
            { entity: { contains: searchParams.q, mode: "insensitive" } },
            {
              user: { fullName: { contains: searchParams.q, mode: "insensitive" } },
            },
          ],
        }
      : {}),
  };

  const [logs, total, entities] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      include: { user: { select: { fullName: true } } },
      orderBy: { createdAt: "desc" },
      skip,
      take,
    }),
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      distinct: ["entity"],
      select: { entity: true },
      orderBy: { entity: "asc" },
    }),
  ]);

  return (
    <AuditLogsClient
      logs={logs}
      entities={entities.map((e) => e.entity)}
      total={total}
      page={page}
      pageSize={pageSize}
    />
  );
}
