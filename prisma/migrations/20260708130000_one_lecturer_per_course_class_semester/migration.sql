-- Business rule: one lecturer per course+class+semester (no co-teaching in
-- V1). Uniqueness moves from (lecturer, course, class, semester) to just
-- (course, class, semester). Guard first: if any course/class/semester
-- already has more than one lecturer assigned, abort with the exact
-- conflicting rows instead of silently dropping data — an admin must
-- delete/reassign one of them first.
DO $$
DECLARE
  conflict_summary TEXT;
BEGIN
  SELECT string_agg(
    format(
      'course=%s class=%s semester=%s (lecturer_ids: %s)',
      course_id, class_id, semester_id, lecturer_ids
    ),
    E'\n'
  )
  INTO conflict_summary
  FROM (
    SELECT
      course_id,
      class_id,
      semester_id,
      string_agg(lecturer_id::text, ', ') AS lecturer_ids
    FROM "lecturer_course_assignments"
    GROUP BY course_id, class_id, semester_id
    HAVING COUNT(*) > 1
  ) conflicts;

  IF conflict_summary IS NOT NULL THEN
    RAISE EXCEPTION E'Cannot enforce one-lecturer-per-course-class-semester: conflicting assignments exist. Delete one lecturer from each of these before re-running this migration:\n%', conflict_summary;
  END IF;
END $$;

-- DropIndex
DROP INDEX "lecturer_course_assignments_lecturer_id_course_id_class_id__key";

-- CreateIndex
CREATE UNIQUE INDEX "lecturer_course_assignments_course_id_class_id_semester_id_key" ON "lecturer_course_assignments"("course_id", "class_id", "semester_id");
