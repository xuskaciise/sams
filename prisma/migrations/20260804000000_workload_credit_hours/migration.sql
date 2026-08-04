-- Weekly teaching load for a LecturerCourseAssignment, set by the Workload
-- Excel import (see CLAUDE.md's "Workload Excel import + auto-timetable
-- generation" business rule) and consumed by the sequential auto-timetable
-- generator (lib/auto-timetable.ts) to pick a combination of EXISTING Shift
-- templates whose total duration comes closest to this value. Nullable and
-- additive only — every assignment created any other way (manual Add
-- Assignment, Bulk Assign, Open Semester wizard) simply never sets it and
-- is not eligible for auto-generation; no backfill needed.
ALTER TABLE "lecturer_course_assignments" ADD COLUMN "credit_hours" DECIMAL(4,2);
