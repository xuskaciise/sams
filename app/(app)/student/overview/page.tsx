import { notFound } from "next/navigation";
import { CheckCircle2, ClipboardList, TrendingUp } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { getStudentSemesterOverview } from "../queries";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
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

export default async function StudentOverviewPage() {
  const user = await getCurrentUser();
  const overview = await getStudentSemesterOverview(user!.id);
  if (!overview) notFound();

  const { activeSemester, activeCount, completedCount, currentAverage, courses } =
    overview;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Semester Overview"
        description="A summary of your current academic progress, focusing on course performance and completion status for the current term."
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <ClipboardList className="size-4 text-primary" />
              <CardDescription>Active Courses</CardDescription>
            </div>
            <CardTitle className="text-3xl">{activeCount}</CardTitle>
            <p className="text-xs text-muted-foreground">
              {activeSemester
                ? `${activeSemester.name} (${activeSemester.academicYear.name})`
                : "No active semester"}
            </p>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <CheckCircle2 className="size-4 text-green-600" />
              <CardDescription>Completed</CardDescription>
            </div>
            <CardTitle className="text-3xl">{completedCount}</CardTitle>
            <p className="text-xs text-muted-foreground">Completed courses</p>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <TrendingUp className="size-4 text-amber-600" />
              <CardDescription>Current Average</CardDescription>
            </div>
            <CardTitle className="text-3xl">
              {currentAverage !== null ? `${currentAverage}%` : "—"}
            </CardTitle>
            <p className="text-xs text-muted-foreground">Combined CA Marks</p>
          </CardHeader>
        </Card>
      </div>

      <div className="rounded-lg border border-border">
        <div className="border-b border-border p-4">
          <p className="text-sm font-semibold">Course Performance</p>
        </div>
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead>Course Name (Code)</TableHead>
              <TableHead className="text-right">Overall CA Mark</TableHead>
              <TableHead>Progress</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {courses.map(({ enrollment, earned, possible, isCorrected }, i) => {
              const pct =
                possible > 0 ? Math.round((earned / possible) * 100) : null;
              return (
                <TableRow
                  key={enrollment.id}
                  className={i % 2 === 1 ? "bg-muted/30" : undefined}
                >
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-medium">
                        {enrollment.course.name}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {enrollment.course.code}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-2">
                      {isCorrected && (
                        <Badge variant="outline">Corrected</Badge>
                      )}
                      <span className="font-semibold text-primary">
                        {possible > 0 ? `${earned} / ${possible}` : "—"}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    {possible > 0 ? (
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-24 overflow-hidden rounded-full bg-muted sm:w-32">
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
                </TableRow>
              );
            })}
            {courses.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={3}
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
    </div>
  );
}
