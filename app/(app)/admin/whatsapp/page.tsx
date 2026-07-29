import { WhatsAppPanel, type WhatsAppSearchParams } from "./panel";

export default async function WhatsAppPage({
  searchParams,
}: {
  searchParams: Promise<WhatsAppSearchParams>;
}) {
  const params = await searchParams;
  return <WhatsAppPanel searchParams={params} />;
}
