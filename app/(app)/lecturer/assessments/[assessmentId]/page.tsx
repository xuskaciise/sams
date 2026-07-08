import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getAssessmentWithContext, getActiveEnrollments } from "./queries";
import { AssessmentDetailClient } from "./assessment-detail-client";
import type { GridRow } from "./result-grid";

export default async function AssessmentDetailPage({
  params,
}: {
  params: Promise<{ assessmentId: string }>;
}) {
  const { assessmentId } = await params;
  const user = await getCurrentUser();

  const assessment = await getAssessmentWithContext(assessmentId);
  if (!assessment || assessment.assignment.lecturer.userId !== user!.id) {
    notFound();
  }

  const [enrollments, results, groups] = await Promise.all([
    getActiveEnrollments(assessment.assignment),
    prisma.assessmentResult.findMany({ where: { assessmentId } }),
    assessment.mode === "GROUP"
      ? prisma.studentGroup.findMany({
          where: { assignmentId: assessment.assignmentId },
          include: {
            members: { include: { student: true } },
          },
          orderBy: { name: "asc" },
        })
      : Promise.resolve([]),
  ]);

  const groupNameByStudentId = new Map<string, string>();
  for (const group of groups) {
    for (const member of group.members) {
      groupNameByStudentId.set(member.studentId, group.name);
    }
  }

  const resultByEnrollmentId = new Map(
    results.map((r) => [r.enrollmentId, r])
  );

  const gridRows: GridRow[] = enrollments.map((enrollment) => {
    const result = resultByEnrollmentId.get(enrollment.id);
    return {
      enrollmentId: enrollment.id,
      studentId: enrollment.studentId,
      studentName: enrollment.student.fullName,
      studentNo: enrollment.student.studentNo,
      groupName: groupNameByStudentId.get(enrollment.student.id) ?? null,
      resultId: result?.id ?? null,
      mark: result?.mark ? Number(result.mark) : null,
      attendanceStatus: result?.attendanceStatus ?? "PRESENT",
      updatedAt: result?.updatedAt.toISOString() ?? null,
      isCorrected: result?.isCorrected ?? false,
    };
  });

  return (
    <AssessmentDetailClient
      assessmentId={assessmentId}
      title={assessment.title}
      status={assessment.status}
      mode={assessment.mode}
      maximumMarks={Number(assessment.maximumMarks)}
      typeName={assessment.assessmentType.name}
      courseName={assessment.assignment.course.name}
      className={assessment.assignment.class.name}
      semesterName={`${assessment.assignment.semester.name} (${assessment.assignment.semester.academicYear.name})`}
      gridRows={gridRows}
      groups={groups}
      assignmentId={assessment.assignmentId}
    />
  );
}
