// Pure, DB-free: decides which EXISTING flow a Student Results Lookup row
// routes to. This page never invents a new write path — every action below
// maps 1:1 to a Server Action already used by the per-assessment Marks Entry
// Grid (saveResult / addLateResult / publishLateResult / correctResult), and
// each of those re-checks permission + ownership + status server-side
// regardless of what this function says. This only decides what the UI
// OFFERS.

export type AssessmentStatus = "DRAFT" | "PUBLISHED" | "CLOSED";
export type ResultStatus = "DRAFT" | "PUBLISHED";
export type EnrollmentStatus = "ACTIVE" | "TRANSFERRED" | "DROPPED" | "COMPLETED";

export type LookupRowAction =
  // No result, assessment DRAFT -> inline entry via saveResult.
  | { kind: "ENTER" }
  // No result, assessment PUBLISHED -> addLateResult (lands as DRAFT).
  | { kind: "LATE_ADD" }
  // Existing DRAFT result -> inline edit via saveResult. `canPublish` is
  // true only for a late-added draft on an already-PUBLISHED assessment
  // (publishLateResult); a draft under a DRAFT assessment is published
  // with the whole assessment from its own page.
  | { kind: "EDIT_DRAFT"; canPublish: boolean }
  // PUBLISHED result on a PUBLISHED assessment -> correctResult.
  | { kind: "CORRECT" }
  | { kind: "READ_ONLY"; reason: string };

export function resolveLookupRowAction(input: {
  assessmentStatus: AssessmentStatus;
  resultStatus: ResultStatus | null;
  enrollmentStatus: EnrollmentStatus;
}): LookupRowAction {
  const { assessmentStatus, resultStatus, enrollmentStatus } = input;

  if (assessmentStatus === "CLOSED") {
    return { kind: "READ_ONLY", reason: "Semester closed — results are locked." };
  }
  // Same roster rule as the Marks Entry Grid, which only ever lists ACTIVE
  // enrollments: a transferred/completed enrollment is history here.
  if (enrollmentStatus !== "ACTIVE") {
    return {
      kind: "READ_ONLY",
      reason: `Enrollment is ${enrollmentStatus.toLowerCase()} — not editable here.`,
    };
  }

  if (resultStatus === null) {
    return assessmentStatus === "DRAFT" ? { kind: "ENTER" } : { kind: "LATE_ADD" };
  }
  if (resultStatus === "DRAFT") {
    return { kind: "EDIT_DRAFT", canPublish: assessmentStatus === "PUBLISHED" };
  }
  if (assessmentStatus === "PUBLISHED") return { kind: "CORRECT" };
  // A PUBLISHED result under a DRAFT assessment can't occur via the normal
  // flows (publish is all-at-once); correctResult would reject it anyway.
  return {
    kind: "READ_ONLY",
    reason: "Published result on a draft assessment — open the assessment to review.",
  };
}
