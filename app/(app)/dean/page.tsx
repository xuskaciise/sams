import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRightLeft, Lock, BarChart3 } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/layout/page-header";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

// The Dean hub used to live at /dean?tab=transfers|close-semester|reports;
// those three now have their own sidebar links and routes. Keep old
// bookmarks/links working by forwarding here.
const LEGACY_TAB_REDIRECTS: Record<string, string> = {
  transfers: "/dean/transfers",
  "close-semester": "/dean/close-semester",
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

  const activeSemester = await prisma.semester.findFirst({
    where: { isActive: true },
    include: { academicYear: true },
  });

  let assessmentCounts = { total: 0, draft: 0, published: 0 };
  if (activeSemester) {
    const assessments = await prisma.assessment.findMany({
      where: { assignment: { semesterId: activeSemester.id }, deletedAt: null },
      select: { status: true },
    });
    assessmentCounts = {
      total: assessments.length,
      draft: assessments.filter((a) => a.status === "DRAFT").length,
      published: assessments.filter((a) => a.status === "PUBLISHED").length,
    };
  }

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
            render={<Link href="/dean/close-semester" />}
          >
            <Lock className="size-4" />
            Close Semester
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
