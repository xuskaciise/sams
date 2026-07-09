import { AuditLogsPanel, type AuditLogsSearchParams } from "./panel";

export default async function AuditLogsPage({
  searchParams,
}: {
  searchParams: Promise<AuditLogsSearchParams>;
}) {
  const params = await searchParams;
  return <AuditLogsPanel searchParams={params} />;
}
