import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  getGroupsForAssignment,
  getActiveEnrollmentsForAssignment,
} from "./queries";
import { GroupsClient } from "./groups-client";

export default async function AssignmentGroupsPage({
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

  const [groups, enrollments] = await Promise.all([
    getGroupsForAssignment(assignmentId),
    getActiveEnrollmentsForAssignment(assignment),
  ]);

  return (
    <GroupsClient
      assignmentId={assignmentId}
      groups={groups}
      enrollments={enrollments}
      courseName={assignment.course.name}
      className={assignment.class.name}
      semesterName={`${assignment.semester.name} (${assignment.semester.academicYear.name})`}
    />
  );
}
