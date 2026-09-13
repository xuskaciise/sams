-- Form 2 correction: a missed-exam record now references the SPECIFIC
-- StudentCourseEnrollment it's about (enrollment_id) instead of a bare
-- course_id + assignment_id pair. This is what makes a repeated course
-- (two enrollments for the same course, at different semester levels/
-- attempts) correctly attributable to the exact attempt a missed exam
-- happened in, and it's also what lets Form 2 look a student up by
-- student_no and show their FULL enrollment history (every semester
-- level they've ever been enrolled in) without needing a
-- LecturerCourseAssignment match at all.
--
-- Defensive backfill: same reasoning as the prior two migrations in this
-- feature — nothing has ever been `prisma migrate deploy`ed against a
-- real database from this environment, so missed_exam_records almost
-- certainly has zero rows anywhere this runs. Handled properly anyway:
-- for each existing row, the matching StudentCourseEnrollment is
-- resolved via (student_id, course_id) + the OLD assignment's
-- (class_id, semester_id) — preferring an ACTIVE enrollment, then the
-- most recently created one if several match. A row that still can't be
-- resolved (only possible if the assignment/enrollment data itself was
-- already inconsistent) is deleted rather than left to violate the new
-- NOT NULL constraint — expected to affect zero rows in practice.

-- Add the new (nullable-for-now) column
ALTER TABLE "missed_exam_records" ADD COLUMN "enrollment_id" TEXT;

-- Backfill from the old course_id + assignment_id pair
UPDATE "missed_exam_records" mer
SET "enrollment_id" = matched.id
FROM (
  SELECT DISTINCT ON (mer2.id) mer2.id AS mer_id, sce.id
  FROM "missed_exam_records" mer2
  JOIN "lecturer_course_assignments" lca ON lca.id = mer2.assignment_id
  JOIN "student_course_enrollments" sce
    ON sce.student_id = mer2.student_id
   AND sce.course_id = mer2.course_id
   AND sce.class_id = lca.class_id
   AND sce.semester_id = lca.semester_id
  ORDER BY mer2.id, (sce.status = 'ACTIVE') DESC, sce.enrolled_at DESC
) AS matched
WHERE matched.mer_id = mer.id;

-- Any row that still has no match (expected: none) can't satisfy the new
-- NOT NULL constraint below — remove rather than block the migration.
DELETE FROM "missed_exam_records" WHERE "enrollment_id" IS NULL;

-- Drop the old course_id/assignment_id columns (FKs + indexes go with them)
ALTER TABLE "missed_exam_records" DROP CONSTRAINT "missed_exam_records_course_id_fkey";
ALTER TABLE "missed_exam_records" DROP CONSTRAINT "missed_exam_records_assignment_id_fkey";
DROP INDEX "missed_exam_records_assignment_id_idx";
DROP INDEX "missed_exam_records_course_id_idx";
ALTER TABLE "missed_exam_records" DROP COLUMN "course_id";
ALTER TABLE "missed_exam_records" DROP COLUMN "assignment_id";

-- Make the new column required and add its own FK + index
ALTER TABLE "missed_exam_records" ALTER COLUMN "enrollment_id" SET NOT NULL;
CREATE INDEX "missed_exam_records_enrollment_id_idx" ON "missed_exam_records"("enrollment_id");
ALTER TABLE "missed_exam_records" ADD CONSTRAINT "missed_exam_records_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "student_course_enrollments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
