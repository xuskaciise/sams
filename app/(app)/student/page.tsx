import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUser, getSessionContext } from "@/lib/auth";
import { getStudentDashboardData } from "./queries";
import { getMyLeaveNoticesForStudent } from "@/app/(app)/admin/daily-log/queries";
import { formatClassLabel } from "@/lib/class-label";
import { PageHeader } from "@/components/layout/page-header";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";

export default async function StudentDashboardPage() {
  const user = await getCurrentUser();
  const ctx = await getSessionContext();
  const canViewOwnDailyLog = ctx?.permissions.has("dailylog.view.own") ?? false;

  const [data, myLeaveNotices] = await Promise.all([
    getStudentDashboardData(user!.id),
    canViewOwnDailyLog ? getMyLeaveNoticesForStudent(user!.id) : Promise.resolve([]),
  ]);
  if (!data) notFound();

  const { student, activeSemester, courses, latestPublishedResult } = data;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Dashboard"
        description={`Welcome back, ${student.fullName}.`}
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription>Class</CardDescription>
            <CardTitle>{formatClassLabel(student.class)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Active semester</CardDescription>
            <CardTitle>
              {activeSemester
                ? `${activeSemester.name} (${activeSemester.academicYear.name})`
                : "No active semester"}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Latest published mark</CardDescription>
            {latestPublishedResult ? (
              <>
                <CardTitle>
                  {latestPublishedResult.mark !== null
                    ? Number(latestPublishedResult.mark)
                    : latestPublishedResult.attendanceStatus}
                  {" / "}
                  {Number(latestPublishedResult.assessment.maximumMarks)}
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  {latestPublishedResult.assessment.title} —{" "}
                  {latestPublishedResult.enrollment.course.name}
                </p>
              </>
            ) : (
              <CardTitle className="text-base">None yet</CardTitle>
            )}
          </CardHeader>
        </Card>
      </div>

      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead>Course</TableHead>
              <TableHead>Progress</TableHead>
              <TableHead className="text-right">Published marks</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {courses.map(({ enrollment, earned, possible, gradedCount }, i) => {
              const pct =
                possible > 0 ? Math.round((earned / possible) * 100) : null;
              return (
                <TableRow
                  key={enrollment.id}
                  className={i % 2 === 1 ? "bg-muted/30" : undefined}
                >
                  <TableCell className="font-medium">
                    {enrollment.course.name}
                  </TableCell>
                  <TableCell>
                    {possible > 0 ? (
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-32 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-primary"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {pct}%
                        </span>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        No published marks yet
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {gradedCount > 0 ? `${earned} / ${possible}` : "—"}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="outline"
                      size="sm"
                      nativeButton={false}
                      render={<Link href={`/student/results/${enrollment.id}`} />}
                    >
                      View
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
            {courses.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="text-center text-muted-foreground"
                >
                  {activeSemester
                    ? "You have no active enrollments this semester."
                    : "There is no active semester right now."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {canViewOwnDailyLog && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-semibold">My Leave Notices</p>
          <div className="rounded-lg border border-border">
            <Table>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Faculty</TableHead>
                  <TableHead>Note</TableHead>
                  <TableHead>Logged by</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {myLeaveNotices.map((entry, i) => (
                  <TableRow
                    key={entry.id}
                    className={i % 2 === 1 ? "bg-muted/30" : undefined}
                  >
                    <TableCell className="text-muted-foreground">
                      {entry.entryDate.toLocaleDateString()}
                    </TableCell>
                    <TableCell>{entry.department.name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {entry.description ?? "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {entry.author.fullName}
                    </TableCell>
                  </TableRow>
                ))}
                {myLeaveNotices.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground">
                      No leave notices logged for you.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}
