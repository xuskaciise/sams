// Display-only helper: appends a class's current cycle level everywhere a
// class is referenced OUTSIDE its own management table (Academic
// Structure > Classes, admin/classes/*, which shows Class.name alone,
// unchanged). Never touches Class.name/section/studyMode or any naming
// rule — purely a label suffix for clarity elsewhere (Timetable, Reports,
// Students, Enrollments, Assignments, dashboards, pickers).
//
// currentSemesterNumber (1..8) is the BATCH's level in its own cycle —
// see the Class Timetable / batch model business rules in CLAUDE.md.
// Nullable for legacy/incomplete classes (no batch data yet), in which
// case the label falls back to the plain class name, same as every other
// nullable-batch-field fallback in this app.
export interface ClassLabelInput {
  name: string;
  currentSemesterNumber: number | null;
}

export function formatClassLabel(cls: ClassLabelInput): string {
  return cls.currentSemesterNumber === null
    ? cls.name
    : `${cls.name} (Semester ${cls.currentSemesterNumber})`;
}
