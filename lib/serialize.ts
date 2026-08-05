import type { Prisma } from "@prisma/client";

// Prisma's Decimal type isn't a plain object — passing it directly from a
// Server Component to a Client Component, or returning it from a Server
// Action, throws "Only plain objects can be passed to Client
// Components... Decimal objects are not supported." This codebase
// already converts non-nullable Decimal fields with plain `Number(...)`
// everywhere (Assessment.maximumMarks, AssessmentResult.mark) — this is
// the same conversion, just null-safe, for nullable Decimal fields like
// LecturerCourseAssignment.creditHours. Every query whose result crosses
// that Server/Client boundary carrying a raw LecturerCourseAssignment (or
// anything nesting one) must run creditHours through this first.
export function nullableDecimalToNumber(value: Prisma.Decimal | null): number | null {
  return value === null ? null : Number(value);
}
