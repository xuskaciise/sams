import Link from "next/link";
import { redirect } from "next/navigation";
import { FileText, Users, ClipboardList } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { getSessionContext } from "@/lib/auth";
import { prisma } from "@/lib/db";

export default async function DashboardPage() {
  const ctx = await getSessionContext();
  if (!ctx) {
    redirect("/login");
  }
  const { user, roleNames } = ctx;

  // Landing priority ADMIN > DEAN > LECTURER > STUDENT (role names are
  // presentation only — every page/action still enforces permissions).
  // Single-role users land exactly where they did before RBAC.
  if (roleNames.includes("ADMIN")) {
    return <DashboardShell name={user.fullName} overview={<AdminOverview />} />;
  }
  if (roleNames.includes("DEAN")) {
    redirect("/dean");
  }
  if (roleNames.includes("LECTURER")) {
    return (
      <DashboardShell
        name={user.fullName}
        overview={<LecturerOverview userId={user.id} />}
      />
    );
  }
  if (roleNames.includes("STUDENT")) {
    redirect("/student");
  }

  // Custom-role-only user: nothing role-specific to show.
  return (
    <DashboardShell
      name={user.fullName}
      overview={
        <p className="text-sm text-muted-foreground">
          Use the sidebar to get to your tools.
        </p>
      }
    />
  );
}

function DashboardShell({
  name,
  overview,
}: {
  name: string;
  overview: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Dashboard" description={`Welcome back, ${name}.`} />
      {overview}
    </div>
  );
}

async function AdminOverview() {
  const [studentCount, lecturerCount, activeClassCount, activeSemester, recentAudit] =
    await Promise.all([
      prisma.student.count(),
      prisma.user.count({
        where: {
          userRoles: { some: { role: { name: "LECTURER" } } },
          deletedAt: null,
          isActive: true,
        },
      }),
      prisma.class.count({
        where: { deletedAt: null, currentSemesterNumber: { not: null } },
      }),
      prisma.semester.findFirst({
        where: { isActive: true },
        include: { academicYear: true },
      }),
      prisma.auditLog.findMany({
        orderBy: { createdAt: "desc" },
        take: 8,
        include: { user: { select: { fullName: true } } },
      }),
    ]);

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader>
            <CardDescription>Students</CardDescription>
            <CardTitle>{studentCount}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Lecturers</CardDescription>
            <CardTitle>{lecturerCount}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Active classes</CardDescription>
            <CardTitle>{activeClassCount}</CardTitle>
          </CardHeader>
        </Card>
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
      </div>

      <div className="rounded-lg border border-border p-4">
        <p className="mb-3 text-sm font-semibold">Quick links</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" nativeButton={false} render={<Link href="/admin/users" />}>
            <Users className="size-4" />
            Add user
          </Button>
          <Button
            variant="outline"
            nativeButton={false}
            render={<Link href="/admin/students" />}
          >
            <ClipboardList className="size-4" />
            Register student
          </Button>
          <Button
            variant="outline"
            nativeButton={false}
            render={<Link href="/admin/calendar?tab=semesters" />}
          >
            <FileText className="size-4" />
            Open semester
          </Button>
          <Button
            variant="outline"
            nativeButton={false}
            render={<Link href="/admin/curriculum?tab=assignments" />}
          >
            <ClipboardList className="size-4" />
            Assignments
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-sm font-semibold">Recent activity</p>
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader className="sticky top-0 bg-card">
              <TableRow>
                <TableHead>Action</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>By</TableHead>
                <TableHead className="text-right">When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recentAudit.map((entry, i) => (
                <TableRow
                  key={entry.id}
                  className={i % 2 === 1 ? "bg-muted/30" : undefined}
                >
                  <TableCell className="font-medium">{entry.action}</TableCell>
                  <TableCell className="text-muted-foreground">{entry.entity}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {entry.user?.fullName ?? "System"}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {entry.createdAt.toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
              {recentAudit.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground">
                    No activity yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </>
  );
}

async function LecturerOverview({ userId }: { userId: string }) {
  const [assignedCourseCount, draftAssessments] = await Promise.all([
    prisma.lecturerCourseAssignment.count({ where: { lecturer: { userId } } }),
    prisma.assessment.findMany({
      where: {
        assignment: { lecturer: { userId } },
        status: "DRAFT",
        deletedAt: null,
      },
      include: { assignment: { include: { course: true, class: true } } },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardDescription>Assigned courses</CardDescription>
            <CardTitle>{assignedCourseCount}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Assessments needing attention</CardDescription>
            <CardTitle>{draftAssessments.length}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold">Drafts not yet published</p>
          <Button variant="outline" size="sm" nativeButton={false} render={<Link href="/lecturer" />}>
            Go to My Courses
          </Button>
        </div>
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader className="sticky top-0 bg-card">
              <TableRow>
                <TableHead>Assessment</TableHead>
                <TableHead>Course</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {draftAssessments.map((assessment, i) => (
                <TableRow
                  key={assessment.id}
                  className={i % 2 === 1 ? "bg-muted/30" : undefined}
                >
                  <TableCell className="font-medium">{assessment.title}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {assessment.assignment.course.name} · {assessment.assignment.class.name}
                  </TableCell>
                  <TableCell>
                    <Badge variant="draft">Draft</Badge>
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="outline"
                      size="sm"
                      nativeButton={false}
                      render={<Link href={`/lecturer/assessments/${assessment.id}`} />}
                    >
                      Enter results
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {draftAssessments.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground">
                    Nothing needs attention — every assessment is published.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </>
  );
}
