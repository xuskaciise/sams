import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/auth";
import { PageHeader } from "@/components/layout/page-header";
import { StudentLookupClient } from "./student-lookup-client";

export default async function StudentResultsLookupPage() {
  const ctx = await getSessionContext();
  if (!ctx || !ctx.permissions.has("results.enter")) redirect("/");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Student Results Lookup"
        description="Look up one student and enter or correct their results across all of your own courses."
      />
      <StudentLookupClient
        canCorrect={ctx.permissions.has("results.correct")}
        canPublish={ctx.permissions.has("assessment.publish")}
      />
    </div>
  );
}
