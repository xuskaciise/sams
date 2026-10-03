"use server";

import { requirePermission } from "@/lib/auth";
import { getStudentResultsForLecturer } from "./queries";

// Read-only lookup. Every WRITE from this page goes straight to the existing
// per-assessment actions (saveResult / addLateResult / publishLateResult /
// correctResult in lecturer/assessments/[assessmentId]/actions.ts), which
// re-check their own permission + requireAssessmentOwner + status — this
// page adds no new write path and no new audit action.
export async function lookupStudentResults(studentNo: string) {
  const user = await requirePermission("results.enter");
  return getStudentResultsForLecturer(user.id, String(studentNo ?? ""));
}
