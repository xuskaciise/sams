import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getStudentCourseDetail } from "../../queries";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";

export default async function StudentCourseDetailPage({
  params,
}: {
  params: Promise<{ enrollmentId: string }>;
}) {
  const { enrollmentId } = await params;
  const user = await getCurrentUser();
  const data = await getStudentCourseDetail(user!.id, enrollmentId);
  if (!data) notFound();

  const { enrollment, assessments } = data;

  let earned = 0;
  let possible = 0;
  for (const assessment of assessments) {
    const result = assessment.results[0];
    if (result) {
      earned += result.mark !== null ? Number(result.mark) : 0;
      possible += Number(assessment.maximumMarks);
    }
  }
  const pct = possible > 0 ? Math.round((earned / possible) * 100) : null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={enrollment.course.name}
        description={`${enrollment.class.name} · ${enrollment.semester.name}`}
      />

      <div className="rounded-lg border border-border bg-card p-4">
        <p className="text-sm font-semibold">Semester progress</p>
        {possible > 0 ? (
          <div className="mt-2 flex items-center gap-3">
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-sm text-muted-foreground">
              {earned} / {possible} ({pct}%)
            </span>
          </div>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">
            No published marks yet.
          </p>
        )}
      </div>

      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead>Assessment</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Max marks</TableHead>
              <TableHead className="text-right">My mark</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {assessments.map((assessment, i) => {
              const published = assessment.status !== "DRAFT";
              // The query only ever returns a PUBLISHED result for THIS
              // enrollment (see queries.ts) — a null/undefined result here
              // always means "nothing to show yet", whether that's because
              // the assessment is still a draft or because it's published
              // but this student has no mark row. Either way it renders the
              // same "—", so a draft's existence is never inferable.
              const result = assessment.results[0] ?? null;
              return (
                <TableRow
                  key={assessment.id}
                  className={i % 2 === 1 ? "bg-muted/30" : undefined}
                >
                  <TableCell className="font-medium">
                    {assessment.title}
                  </TableCell>
                  <TableCell>{assessment.assessmentType.name}</TableCell>
                  <TableCell className="text-right">
                    {Number(assessment.maximumMarks)}
                  </TableCell>
                  <TableCell className="text-right">
                    {result ? (
                      <div className="flex flex-col items-end gap-1">
                        <div className="flex items-center gap-2">
                          {result.isCorrected && (
                            <Badge variant="outline">Corrected</Badge>
                          )}
                          <span>
                            {result.attendanceStatus === "PRESENT"
                              ? result.mark !== null
                                ? Number(result.mark)
                                : "—"
                              : result.attendanceStatus === "ABSENT"
                                ? "Absent"
                                : "Exempt"}
                          </span>
                        </div>
                        {result.feedback && (
                          <span className="max-w-56 text-right text-xs text-muted-foreground">
                            {result.feedback}
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={published ? "published" : "draft"}>
                      {published ? "Published" : "Not published yet"}
                    </Badge>
                  </TableCell>
                </TableRow>
              );
            })}
            {assessments.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="text-center text-muted-foreground"
                >
                  No assessments have been created for this course yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
