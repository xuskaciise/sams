import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getStudentCourseDetail } from "../../queries";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { ProgressRing } from "@/components/ui/progress-ring";

export default async function StudentResultsCourseDetailPage({
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
  const heroLabel =
    possible > 0 ? "Current running average" : "No marks published yet";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={`${enrollment.course.name} (${enrollment.course.code})`}
        description={`${enrollment.class.name} · ${enrollment.semester.name}`}
      />

      <div className="relative overflow-hidden rounded-xl border border-border bg-card p-6">
        <div className="absolute inset-x-0 top-0 h-1 bg-primary" />

        {/* Mobile: circular ring hero */}
        <div className="flex flex-col items-center gap-2 py-2 sm:hidden">
          {possible > 0 ? (
            <ProgressRing value={earned} max={possible} label={heroLabel} />
          ) : (
            <p className="text-sm text-muted-foreground">{heroLabel}</p>
          )}
        </div>

        {/* Desktop: plain "overall mark" + component list side by side */}
        <div className="hidden gap-6 sm:grid sm:grid-cols-2">
          <div className="flex flex-col items-center justify-center gap-1 rounded-lg border border-border p-6 text-center">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Overall mark
            </p>
            {possible > 0 ? (
              <p className="text-4xl font-semibold text-primary">
                {earned}
                <span className="text-lg text-muted-foreground"> / {possible}</span>
              </p>
            ) : (
              <p className="text-lg text-muted-foreground">—</p>
            )}
            <p className="text-sm text-muted-foreground">{heroLabel}</p>
          </div>

          <div className="rounded-lg border border-border p-4">
            <p className="mb-3 text-sm font-semibold">Component marks</p>
            <div className="flex flex-col divide-y divide-border">
              {assessments.map((assessment) => {
                const result = assessment.results[0] ?? null;
                const published = assessment.status !== "DRAFT";
                return (
                  <div
                    key={assessment.id}
                    className="flex items-center justify-between gap-3 py-2 text-sm"
                  >
                    <span className="font-medium">{assessment.title}</span>
                    {published && result ? (
                      <span className="flex items-center gap-2 text-right">
                        {result.isCorrected && (
                          <Badge variant="outline">Corrected</Badge>
                        )}
                        <MarkValue result={result} maximumMarks={Number(assessment.maximumMarks)} />
                      </span>
                    ) : (
                      <Badge variant="draft">Not published yet</Badge>
                    )}
                  </div>
                );
              })}
              {assessments.length === 0 && (
                <p className="py-2 text-sm text-muted-foreground">
                  No assessments have been created for this course yet.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-foreground sm:hidden">
          Assessments
        </h2>
        {assessments.map((assessment) => {
          const result = assessment.results[0] ?? null;
          const published = assessment.status !== "DRAFT";
          return (
            <div
              key={assessment.id}
              className={`rounded-lg border p-4 sm:hidden ${
                published
                  ? "border-border bg-card"
                  : "border-border bg-muted/40"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-1.5">
                  <span className="font-medium text-foreground">
                    {assessment.title}
                  </span>
                  <Badge
                    variant={published ? "published" : "draft"}
                    className="w-fit"
                  >
                    {published ? "Published" : "Not published yet"}
                  </Badge>
                  {result?.feedback && (
                    <span className="max-w-56 text-xs text-muted-foreground">
                      {result.feedback}
                    </span>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1 text-right">
                  {result?.isCorrected && (
                    <Badge variant="outline">Corrected</Badge>
                  )}
                  {published && result ? (
                    <MarkValue
                      result={result}
                      maximumMarks={Number(assessment.maximumMarks)}
                    />
                  ) : (
                    <>
                      <span className="text-muted-foreground">
                        — / {Number(assessment.maximumMarks)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        Pending
                      </span>
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {assessments.length === 0 && (
          <p className="text-sm text-muted-foreground sm:hidden">
            No assessments have been created for this course yet.
          </p>
        )}
      </div>
    </div>
  );
}

function MarkValue({
  result,
  maximumMarks,
}: {
  result: { mark: unknown; attendanceStatus: string };
  maximumMarks: number;
}) {
  if (result.attendanceStatus === "ABSENT") {
    return <span className="font-medium">Absent</span>;
  }
  if (result.attendanceStatus === "EXEMPT") {
    return <span className="font-medium">Exempt</span>;
  }
  return (
    <span className="font-medium">
      {result.mark !== null ? Number(result.mark) : "—"} / {maximumMarks}
    </span>
  );
}
