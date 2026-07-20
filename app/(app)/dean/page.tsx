import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRightLeft, BarChart3 } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getDeanDepartmentIds } from "@/lib/dean-scope";
import { PageHeader } from "@/components/layout/page-header";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getDeanAssessmentCounts } from "./queries";

// The Dean hub used to live at /dean?tab=transfers|close-semester|reports;
// transfers/reports now have their own sidebar links and routes. Close
// Semester moved to Admin (Academic Calendar > Semesters) — the legacy
// tab link now forwards there instead. Keep old bookmarks/links working.
const LEGACY_TAB_REDIRECTS: Record<string, string> = {
  transfers: "/dean/transfers",
  "close-semester": "/admin/calendar?tab=semesters",
  reports: "/dean/reports",
};

export default async function DeanDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  if (tab && LEGACY_TAB_REDIRECTS[tab]) {
    redirect(LEGACY_TAB_REDIRECTS[tab]);
  }

  const user = await getCurrentUser();
  const departmentIds = await getDeanDepartmentIds(user!.id);

  if (departmentIds.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Dashboard"
          description={`Welcome back, ${user?.fullName ?? ""}.`}
        />
        <Card>
          <CardHeader>
            <CardTitle>No faculties assigned yet</CardTitle>
            <CardDescription>
              Contact the administrator to get faculties assigned to your
              account.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const activeSemester = await prisma.semester.findFirst({
    where: { isActive: true },
    include: { academicYear: true },
  });

  const assessmentCounts = activeSemester
    ? await getDeanAssessmentCounts(departmentIds, activeSemester.id)
    : { total: 0, draft: 0, published: 0 };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Dashboard"
        description={`Welcome back, ${user?.fullName ?? ""}.`}
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader>
            <CardDescription>Active semester</CardDescription>
            <CardTitle className="text-base">
              {activeSemester
                ? `${activeSemester.name} (${activeSemester.academicYear.name})`
                : "None"}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Status</CardDescription>
            {activeSemester ? (
              <Badge
                variant={activeSemester.isClosed ? "outline" : "published"}
                className="w-fit"
              >
                {activeSemester.isClosed ? "Closed" : "Open"}
              </Badge>
            ) : (
              <CardTitle className="text-base">—</CardTitle>
            )}
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Open assessments</CardDescription>
            <CardTitle>{assessmentCounts.total}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Unpublished drafts</CardDescription>
            <CardTitle>{assessmentCounts.draft}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <div className="rounded-lg border border-border p-4">
        <p className="mb-3 text-sm font-semibold">Quick links</p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            nativeButton={false}
            render={<Link href="/dean/transfers" />}
          >
            <ArrowRightLeft className="size-4" />
            Ownership Transfer
          </Button>
          <Button
            variant="outline"
            nativeButton={false}
            render={<Link href="/dean/reports" />}
          >
            <BarChart3 className="size-4" />
            Reports
          </Button>
        </div>
      </div>
    </div>
  );
}
