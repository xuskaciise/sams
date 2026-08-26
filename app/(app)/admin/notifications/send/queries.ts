import { prisma } from "@/lib/db";
import { classDeanWhere, studentDeanWhere, lecturerDeanWhere } from "@/lib/dean-scope";
import { resolveSenderScope, getLecturerAssignmentTuples, type SenderScope } from "./recipients";

export interface ManualTemplateOption {
  id: string;
  eventKey: string;
  name: string;
  description: string | null;
  templateText: string;
}

export interface PickerOption {
  id: string;
  label: string;
  keywords?: string[];
}

export interface SendNotificationData {
  scope: SenderScope;
  templates: ManualTemplateOption[];
  // ADMIN/DEAN only — a lecturer sends to "my course" via `assignments`
  // instead, never a bare class.
  classes: PickerOption[];
  // ADMIN/DEAN only — the whole-faculty broadcast target.
  departments: PickerOption[];
  // LECTURER only — their own LecturerCourseAssignment rows, standing in
  // for "CLASS" scope (see recipients.ts's resolveManualRecipients).
  assignments: PickerOption[];
  // The individual-recipient picker's option list — scoped identically
  // to how resolveManualRecipients would validate the same pick.
  students: PickerOption[];
  lecturers: PickerOption[];
}

export async function getSendNotificationData(userId: string): Promise<SendNotificationData> {
  const scope = await resolveSenderScope(userId);

  const templates = await prisma.whatsAppMessageTemplate.findMany({
    where: { triggerKind: "MANUAL", deletedAt: null },
    orderBy: { name: "asc" },
    select: { id: true, eventKey: true, name: true, description: true, templateText: true },
  });

  if (scope.tier === "LECTURER") {
    if (!scope.lecturerId) {
      return { scope, templates, classes: [], departments: [], assignments: [], students: [], lecturers: [] };
    }

    const assignments = await prisma.lecturerCourseAssignment.findMany({
      where: { lecturerId: scope.lecturerId },
      select: {
        id: true,
        courseId: true,
        classId: true,
        semesterId: true,
        course: { select: { name: true } },
        class: { select: { name: true } },
        semester: { select: { name: true } },
      },
    });

    const tuples = await getLecturerAssignmentTuples(scope.lecturerId);
    const enrollments =
      tuples.length === 0
        ? []
        : await prisma.studentCourseEnrollment.findMany({
            where: { status: "ACTIVE", OR: tuples },
            distinct: ["studentId"],
            select: {
              student: {
                select: { id: true, studentNo: true, fullName: true, class: { select: { name: true } } },
              },
            },
          });

    return {
      scope,
      templates,
      classes: [],
      departments: [],
      assignments: assignments
        .map((a) => ({
          id: a.id,
          label: `${a.course.name} — ${a.class.name} (${a.semester.name})`,
        }))
        .sort((x, y) => x.label.localeCompare(y.label)),
      students: enrollments
        .map((e) => ({
          id: e.student.id,
          label: `${e.student.studentNo} — ${e.student.fullName}`,
          keywords: [e.student.class.name],
        }))
        .sort((x, y) => x.label.localeCompare(y.label)),
      lecturers: [],
    };
  }

  const isDean = scope.tier === "DEAN";
  const classWhere = isDean ? classDeanWhere(scope.departmentIds) : {};
  const studentWhere = isDean ? studentDeanWhere(scope.departmentIds) : {};
  const lecturerWhere = isDean ? lecturerDeanWhere(scope.departmentIds) : {};
  const departmentWhere = isDean
    ? { id: { in: scope.departmentIds }, deletedAt: null }
    : { deletedAt: null };

  const [classes, departments, students, lecturers] = await Promise.all([
    prisma.class.findMany({ where: classWhere, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.department.findMany({
      where: departmentWhere,
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.student.findMany({
      where: studentWhere,
      select: { id: true, studentNo: true, fullName: true, class: { select: { name: true } } },
      orderBy: { fullName: "asc" },
    }),
    prisma.lecturer.findMany({
      where: lecturerWhere,
      select: { id: true, staffNo: true, fullName: true },
      orderBy: { fullName: "asc" },
    }),
  ]);

  return {
    scope,
    templates,
    classes: classes.map((c) => ({ id: c.id, label: c.name })),
    departments: departments.map((d) => ({ id: d.id, label: d.name })),
    assignments: [],
    students: students.map((s) => ({
      id: s.id,
      label: `${s.studentNo} — ${s.fullName}`,
      keywords: [s.class.name],
    })),
    lecturers: lecturers.map((l) => ({ id: l.id, label: `${l.staffNo} — ${l.fullName}` })),
  };
}
