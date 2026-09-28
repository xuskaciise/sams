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

export interface CarryOverTotals {
  carriedEarned: number;
  carriedPossible: number;
  // Only set when combining is unambiguous (see combineCarryOverTotals).
  combined: { earned: number; possible: number } | null;
  // Why `combined` is null, when it is (for display).
  combinedHiddenReason: string | null;
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase();
}

// Totals policy (pending an explicit rule from the institution): carried-
// over marks are NEVER merged into the new class's own totals/progress —
// they're always reported as their own subtotal. A combined figure is
// offered ONLY when it's unambiguous, defined as: the carried-over
// assessments and the new class's own assessments share no assessment
// title (case/whitespace-insensitive). A shared title (e.g. both classes
// have a "Quiz 1") signals the same CA component may have been graded
// twice, so a naive sum would double-count — the combined figure is then
// hidden with the reason. Pure, DB-free.
export function combineCarryOverTotals(
  own: { earned: number; possible: number; titles: string[] },
  sources: CarriedOverSource[]
): CarryOverTotals {
  const carriedEarned = sources.reduce((sum, s) => sum + s.earned, 0);
  const carriedPossible = sources.reduce((sum, s) => sum + s.possible, 0);
  if (sources.length === 0 || carriedPossible === 0) {
    return { carriedEarned, carriedPossible, combined: null, combinedHiddenReason: null };
  }

  const ownTitles = new Set(own.titles.map(normalizeTitle));
  const seen = new Set<string>();
  const overlapping: string[] = [];
  for (const source of sources) {
    for (const m of source.marks) {
      const key = normalizeTitle(m.title);
      if (ownTitles.has(key) || seen.has(key)) overlapping.push(m.title);
      seen.add(key);
    }
  }

  if (overlapping.length > 0) {
    const names = [...new Set(overlapping)].map((t) => `“${t}”`).join(", ");
    return {
      carriedEarned,
      carriedPossible,
      combined: null,
      combinedHiddenReason: `Combined total not shown — ${names} appears in more than one class, so adding them could double-count the same assessment.`,
    };
  }

  return {
    carriedEarned,
    carriedPossible,
    combined: {
      earned: own.earned + carriedEarned,
      possible: own.possible + carriedPossible,
    },
    combinedHiddenReason: null,
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
