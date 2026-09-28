import { prisma } from "@/lib/db";
import { formatClassLabel } from "@/lib/class-label";
import type { CarriedOverMark, CarriedOverSource } from "@/lib/carry-over-format";

export type { CarriedOverMark, CarriedOverSource, CarryOverSubtotal } from "@/lib/carry-over-format";
export { carryOverSubtotal, formatCarriedOverMark } from "@/lib/carry-over-format";

// Carry-over of prior marks after a class transfer.
//
// AssessmentResult rows are NEVER moved or copied on a transfer — they stay
// on the OLD enrollment (now TRANSFERRED), under the OLD assignment's
// assessments, owned by the OLD lecturer. That keeps the ownership rule
// intact (only an assessment's effective owner can ever edit it). Instead,
// the old enrollment's `transferredToId` points at the new enrollment for
// the same course, and every viewer that wants "the marks this student
// already earned for this course" walks that chain BACKWARD from the
// current enrollment. What comes back here is plain, display-only data —
// no result ids, no updatedAt tokens — so nothing reachable from it can be
// fed to saveResult/correctResult; the old results remain editable only by
// their own owner through their own assessment (requireAssessmentOwner).
//
// PUBLISHED results only: a draft mark from the old class is invisible to
// the new lecturer and to the student, same rule as every other read path.

// Bounded chain depth — a student transferred more than this many times
// within ONE course/semester is not a realistic case (and the full
// (student, course, semester, status) unique index already makes a second
// TRANSFERRED row per course/semester impossible), this just guarantees
// the loop terminates.
const MAX_CHAIN_DEPTH = 10;

// For each given (current) enrollment id, the published marks carried over
// from every predecessor enrollment in its transfer chain, closest first.
// Enrollments with no predecessor (or no published predecessor marks) are
// simply absent from the result.
export async function getCarriedOverMarks(
  enrollmentIds: string[]
): Promise<Record<string, CarriedOverSource[]>> {
  const out: Record<string, CarriedOverSource[]> = {};
  if (enrollmentIds.length === 0) return out;

  const rootOf = new Map<string, string>(enrollmentIds.map((id) => [id, id]));
  const predecessors: {
    id: string;
    root: string;
    classLabel: string;
    semesterName: string;
  }[] = [];

  let frontier = [...new Set(enrollmentIds)];
  for (let depth = 0; depth < MAX_CHAIN_DEPTH && frontier.length > 0; depth++) {
    const rows = await prisma.studentCourseEnrollment.findMany({
      where: { transferredToId: { in: frontier } },
      include: { class: true, semester: true },
    });
    const next: string[] = [];
    for (const row of rows) {
      const root = rootOf.get(row.transferredToId!);
      if (!root || rootOf.has(row.id)) continue;
      rootOf.set(row.id, root);
      predecessors.push({
        id: row.id,
        root,
        classLabel: formatClassLabel(row.class),
        semesterName: row.semester.name,
      });
      next.push(row.id);
    }
    frontier = next;
  }
  if (predecessors.length === 0) return out;

  const results = await prisma.assessmentResult.findMany({
    where: {
      enrollmentId: { in: predecessors.map((p) => p.id) },
      status: "PUBLISHED",
      assessment: { deletedAt: null },
    },
    include: {
      assessment: {
        select: {
          id: true,
          title: true,
          maximumMarks: true,
          createdAt: true,
          assessmentType: { select: { name: true } },
          assignment: { select: { lecturer: { select: { fullName: true } } } },
        },
      },
    },
    orderBy: { assessment: { createdAt: "asc" } },
  });

  const resultsByEnrollment = new Map<string, typeof results>();
  for (const r of results) {
    const list = resultsByEnrollment.get(r.enrollmentId) ?? [];
    list.push(r);
    resultsByEnrollment.set(r.enrollmentId, list);
  }

  for (const pred of predecessors) {
    const rows = resultsByEnrollment.get(pred.id) ?? [];
    if (rows.length === 0) continue;
    const marks: CarriedOverMark[] = rows.map((r) => ({
      assessmentId: r.assessment.id,
      title: r.assessment.title,
      typeName: r.assessment.assessmentType.name,
      mark: r.mark !== null ? Number(r.mark) : null,
      maximumMarks: Number(r.assessment.maximumMarks),
      attendanceStatus: r.attendanceStatus,
      isCorrected: r.isCorrected,
    }));
    const source: CarriedOverSource = {
      enrollmentId: pred.id,
      classLabel: pred.classLabel,
      lecturerName: rows[0].assessment.assignment.lecturer.fullName,
      semesterName: pred.semesterName,
      marks,
      earned: marks.reduce((sum, m) => sum + (m.mark ?? 0), 0),
      possible: marks.reduce((sum, m) => sum + m.maximumMarks, 0),
    };
    (out[pred.root] ??= []).push(source);
  }
  return out;
}
