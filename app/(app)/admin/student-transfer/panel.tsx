import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getSessionContext } from "@/lib/auth";
import { classDeanWhere, studentDeanWhere } from "@/lib/dean-scope";
import { formatClassLabel } from "@/lib/class-label";
import { PageHeader } from "@/components/layout/page-header";
import { resolveTransferScope } from "./plan";
import { StudentTransferClient } from "./student-transfer-client";

// Rendered identically at /admin/student-transfer and
// /dean/student-transfer — the real scope is re-derived from the caller's
// ROLE here AND again inside every action (the pickers below are a
// convenience, never the boundary). Same "one implementation, two routes"
// pattern as Timetable / Room Reassignment.
export async function StudentTransferPanel({
  studentId,
}: {
  studentId?: string;
}) {
  const ctx = await getSessionContext();
  if (!ctx?.permissions.has("students.transfer")) {
    redirect("/");
  }

  const { isDean, departmentIds } = await resolveTransferScope(ctx.user.id);

  const [students, classes, activeSemester] = await Promise.all([
    prisma.student.findMany({
      where: {
        isActive: true,
        ...(isDean ? studentDeanWhere(departmentIds) : {}),
      },
      include: { class: true },
      orderBy: { studentNo: "asc" },
    }),
    prisma.class.findMany({
      where: { deletedAt: null, ...(isDean ? classDeanWhere(departmentIds) : {}) },
      orderBy: { name: "asc" },
    }),
    prisma.semester.findFirst({ where: { isActive: true } }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Transfer Student"
        description="Move ONE student to another class mid-semester: their active-semester enrollments are marked Transferred (never deleted), they're enrolled in the new class's courses, and marks already earned in a shared course carry over read-only. For moving a whole group between semesters, use Students → Transfer Students."
      />
      {isDean && departmentIds.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
          No faculties assigned yet — ask an administrator to assign the faculties you oversee.
        </div>
      ) : (
        <StudentTransferClient
          students={students.map((s) => ({
            id: s.id,
            studentNo: s.studentNo,
            fullName: s.fullName,
            classId: s.classId,
            classLabel: formatClassLabel(s.class),
          }))}
          classes={classes.map((c) => ({ id: c.id, label: formatClassLabel(c) }))}
          activeSemesterName={activeSemester?.name ?? null}
          initialStudentId={studentId ?? ""}
        />
      )}
    </div>
  );
}
