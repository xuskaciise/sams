-- Form 2 simplification: Special Exam Registration no longer derives its
-- course list from the student's own enrollment history (and therefore
-- no longer filters by semester-level parity) — office staff now see
-- ALL courses in the system for a looked-up student and manually check
-- off whichever ones actually apply. MissedExamRecord accordingly goes
-- back to referencing the course DIRECTLY (course_id) instead of a
-- specific StudentCourseEnrollment (enrollment_id) — this reverses the
-- prior 20260915000000_missed_exam_record_enrollment_ref migration.
--
-- Defensive backfill: same reasoning as every prior migration in this
-- feature — nothing has ever been `prisma migrate deploy`ed against a
-- real database from this environment, so missed_exam_records almost
-- certainly has zero rows anywhere this runs. Handled properly anyway:
-- each existing row's course_id is resolved via its enrollment's own
-- course_id. A row that still can't be resolved (only possible if the
-- enrollment data itself was already inconsistent) is deleted rather
-- than left to violate the new NOT NULL constraint — expected to affect
-- zero rows in practice.

-- Add the new (nullable-for-now) column
ALTER TABLE "missed_exam_records" ADD COLUMN "course_id" TEXT;

-- Backfill from the enrollment's own course_id
UPDATE "missed_exam_records" mer
SET "course_id" = sce.course_id
FROM "student_course_enrollments" sce
WHERE sce.id = mer.enrollment_id;

-- Any row that still has no match (expected: none) can't satisfy the new
-- NOT NULL constraint below — remove rather than block the migration.
DELETE FROM "missed_exam_records" WHERE "course_id" IS NULL;

-- Drop the old enrollment_id column (its FK + index go with it)
ALTER TABLE "missed_exam_records" DROP CONSTRAINT "missed_exam_records_enrollment_id_fkey";
DROP INDEX "missed_exam_records_enrollment_id_idx";
ALTER TABLE "missed_exam_records" DROP COLUMN "enrollment_id";

-- Make the new column required and add its own FK + index
ALTER TABLE "missed_exam_records" ALTER COLUMN "course_id" SET NOT NULL;
CREATE INDEX "missed_exam_records_course_id_idx" ON "missed_exam_records"("course_id");
ALTER TABLE "missed_exam_records" ADD CONSTRAINT "missed_exam_records_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
