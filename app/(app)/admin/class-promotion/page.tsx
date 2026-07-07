import { redirect } from "next/navigation";

export default async function ClassPromotionRedirect({
  searchParams,
}: {
  searchParams: Promise<{ sourceClassId?: string }>;
}) {
  const { sourceClassId } = await searchParams;
  const params = new URLSearchParams({ tab: "class-promotion" });
  if (sourceClassId) params.set("sourceClassId", sourceClassId);
  redirect(`/admin/students?${params.toString()}`);
}
