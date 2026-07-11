import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import {
  getStudentDashboardData,
  getRecentPublishedMarks,
  getStudentSemesterOverview,
} from "../queries";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { TranscriptDownloadButton } from "./transcript-download-button";

export default async function StudentResultsPage() {
  const user = await getCurrentUser();
  const [dashboard, recentMarks, overview] = await Promise.all([
    getStudentDashboardData(user!.id),
    getRecentPublishedMarks(user!.id, 8),
    getStudentSemesterOverview(user!.id),
  ]);
  if (!dashboard) notFound();

  const { student, courses } = dashboard;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Results"
        description={`${student.fullName} · ${student.class.name}`}
        action={<TranscriptDownloadButton />}
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="flex flex-col gap-6">
          <div className="rounded-lg border border-border">
            <div className="border-b border-border p-4">
              <p className="text-sm font-semibold">
                Recently published marks
              </p>
            </div>
            <Table>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow>
                  <TableHead>Course</TableHead>
                  <TableHead>Assessment</TableHead>
                  <TableHead className="text-right">Mark / Max</TableHead>
                  <TableHead className="text-right">Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentMarks.map((result, i) => (
                  <TableRow
                    key={result.id}
                    className={i % 2 === 1 ? "bg-muted/30" : undefined}
                  >
                    <TableCell className="font-medium">
                      {result.enrollment.course.name} (
                      {result.enrollment.course.code})
                    </TableCell>
                    <TableCell>{result.assessment.title}</TableCell>
                    <TableCell className="text-right">
                      {result.attendanceStatus === "PRESENT"
                        ? `${result.mark !== null ? Number(result.mark) : "—"} / ${Number(result.assessment.maximumMarks)}`
                        : result.attendanceStatus}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {result.publishedAt
                        ? new Date(result.publishedAt).toLocaleDateString()
                        : "—"}
                    </TableCell>
                  </TableRow>
                ))}
                {recentMarks.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={4}
                      className="text-center text-muted-foreground"
                    >
                      No marks have been published yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          <div className="flex flex-col gap-3">
            <p className="text-sm font-semibold">Your courses</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {courses.map(({ enrollment, earned, possible, gradedCount }) => {
                const pct =
                  possible > 0 ? Math.round((earned / possible) * 100) : null;
                return (
                  <Link
                    key={enrollment.id}
                    href={`/student/results/${enrollment.id}`}
                    className="block"
                  >
                    <Card className="transition-colors hover:bg-muted/40">
                      <CardHeader>
                        <CardDescription>
                          {enrollment.course.code}
                        </CardDescription>
                        <CardTitle className="text-base">
                          {enrollment.course.name}
                        </CardTitle>
                      </CardHeader>
                      <div className="px-(--card-spacing) pb-(--card-spacing) text-sm text-muted-foreground">
                        {gradedCount > 0
                          ? `${earned} / ${possible} (${pct}%)`
                          : "No published marks yet"}
                      </div>
                    </Card>
                  </Link>
                );
              })}
              {courses.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  You have no active enrollments this semester.
                </p>
              )}
            </div>
          </div>
        </div>

        {overview && (
          <div className="rounded-lg border border-border p-4">
            <p className="mb-3 text-sm font-semibold">Semester Overview</p>
            <div className="flex flex-col divide-y divide-border">
              {overview.courses.map(({ enrollment, earned, possible, isCorrected }) => {
                const pct =
                  possible > 0 ? Math.round((earned / possible) * 100) : null;
                return (
                  <div key={enrollment.id} className="flex flex-col gap-1 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium">
                          {enrollment.course.code}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {enrollment.course.name}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-primary">
                          {pct !== null ? `${pct}%` : "—"}
                        </span>
                        {isCorrected && (
                          <Badge variant="outline">Corrected</Badge>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              {overview.courses.length === 0 && (
                <p className="py-2 text-sm text-muted-foreground">
                  No active enrollments this semester.
                </p>
              )}
            </div>
            <Button
              variant="outline"
              className="mt-3 w-full"
              nativeButton={false}
              render={<Link href="/student/overview" />}
            >
              View full overview
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
