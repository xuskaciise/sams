// Pure, DB-free types + helpers for carried-over marks (see lib/carry-over.ts
// for the chain walk). Split out so client components can import them
// without pulling the Prisma client into the browser bundle.

export interface CarriedOverMark {
  assessmentId: string;
  title: string;
  typeName: string;
  mark: number | null;
  maximumMarks: number;
  attendanceStatus: string;
  isCorrected: boolean;
}

export interface CarriedOverSource {
  // The TRANSFERRED enrollment the marks live on.
  enrollmentId: string;
  classLabel: string;
  lecturerName: string;
  semesterName: string;
  marks: CarriedOverMark[];
  // Same earned/possible convention as the student portal and reports:
  // a null (absent/exempt) published mark counts as 0 toward earned.
  earned: number;
  possible: number;
}

export interface CarryOverSubtotal {
  earned: number;
  possible: number;
}

// Decided policy: carried-over marks are ALWAYS reported on their own,
// labeled by their original class and lecturer. They are NEVER merged
// into the new class's totals/percentage/progress, and NO combined
// (carried + new) total is ever shown — to the lecturer or the student.
// This is only the carried-over subtotal itself. Pure, DB-free.
export function carryOverSubtotal(sources: CarriedOverSource[]): CarryOverSubtotal {
  return {
    earned: sources.reduce((sum, s) => sum + s.earned, 0),
    possible: sources.reduce((sum, s) => sum + s.possible, 0),
  };
}

export function formatCarriedOverValue(m: CarriedOverMark): string {
  if (m.attendanceStatus === "ABSENT") return "Absent";
  if (m.attendanceStatus === "EXEMPT") return "Exempt";
  return `${m.mark ?? "—"}/${m.maximumMarks}`;
}

// e.g. "Quiz 1: 8.5/10"
export function formatCarriedOverMark(m: CarriedOverMark): string {
  return `${m.title}: ${formatCarriedOverValue(m)}`;
}
