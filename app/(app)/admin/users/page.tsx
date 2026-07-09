import { UsersPanel, type UsersSearchParams } from "./panel";

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<UsersSearchParams>;
}) {
  const params = await searchParams;
  return <UsersPanel searchParams={params} />;
}
