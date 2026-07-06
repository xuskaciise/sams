import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/layout/page-header";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";

export default async function LecturerDashboardPage() {
  const user = await getCurrentUser();

  const assignments = await prisma.lecturerCourseAssignment.findMany({
    where: { lecturer: { userId: user!.id } },
    include: {
      course: true,
      class: true,
      semester: { include: { academicYear: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="My Courses"
        description="Courses you're assigned to teach this semester."
      />

      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead>Course</TableHead>
              <TableHead>Class</TableHead>
              <TableHead>Semester</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {assignments.map((assignment, i) => (
              <TableRow
                key={assignment.id}
                className={i % 2 === 1 ? "bg-muted/30" : undefined}
              >
                <TableCell className="font-medium">
                  {assignment.course.name}
                </TableCell>
                <TableCell>{assignment.class.name}</TableCell>
                <TableCell>
                  {assignment.semester.name} (
                  {assignment.semester.academicYear.name})
                </TableCell>
                <TableCell>
                  <Button
                    variant="outline"
                    size="sm"
                    nativeButton={false}
                    render={
                      <Link href={`/lecturer/assignments/${assignment.id}`} />
                    }
                  >
                    View assessments
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {assignments.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="text-center text-muted-foreground"
                >
                  You have no course assignments yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
