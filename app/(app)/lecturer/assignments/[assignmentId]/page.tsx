import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { AssessmentsClient } from "./assessments-client";

export default async function AssignmentAssessmentsPage({
  params,
}: {
  params: Promise<{ assignmentId: string }>;
}) {
  const { assignmentId } = await params;
  const user = await getCurrentUser();

  const assignment = await prisma.lecturerCourseAssignment.findUnique({
    where: { id: assignmentId },
    include: {
      lecturer: true,
      course: true,
      class: true,
      semester: { include: { academicYear: true } },
    },
  });

  if (!assignment || assignment.lecturer.userId !== user!.id) {
    notFound();
  }

  const [assessments, assessmentTypes] = await Promise.all([
    prisma.assessment.findMany({
      where: { assignmentId, deletedAt: null },
      include: { assessmentType: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.assessmentType.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
    }),
  ]);

  return (
    <AssessmentsClient
      assignmentId={assignmentId}
      assessments={assessments.map((assessment) => ({
        ...assessment,
        maximumMarks: Number(assessment.maximumMarks),
      }))}
      assessmentTypes={assessmentTypes}
      courseName={assignment.course.name}
      className={assignment.class.name}
      semesterName={`${assignment.semester.name} (${assignment.semester.academicYear.name})`}
    />
  );
}
