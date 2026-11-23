-- One-off data fix: the Special Exam Periods recorded under
-- "2026-2027 — Semester 1" (Midterm + Final) actually belong to
-- "2025-2026 — Semester 2", which predates the system. This creates that
-- academic year + semester (inactive and closed; dates are placeholders an
-- admin can edit in Academic Calendar) and moves the periods there, with
-- their missed-exam records untouched. 2026-2027 is left with no periods,
-- for the admin to create fresh. No-op when there is nothing to move.

DO $$
DECLARE
  src_semester_id TEXT;
  ay_id TEXT;
  sem_id TEXT;
BEGIN
  SELECT s."id" INTO src_semester_id
  FROM "semesters" s
  JOIN "academic_years" a ON a."id" = s."academic_year_id"
  WHERE a."name" = '2026-2027' AND s."semester_number" = 1;

  IF src_semester_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM "special_exam_periods" WHERE "semester_id" = src_semester_id
  ) THEN
    RAISE NOTICE 'No 2026-2027 Semester 1 exam periods to move; skipping.';
    RETURN;
  END IF;

  SELECT "id" INTO ay_id FROM "academic_years" WHERE "name" = '2025-2026';
  IF ay_id IS NULL THEN
    ay_id := gen_random_uuid()::text;
    INSERT INTO "academic_years" ("id", "name", "start_date", "end_date", "is_active")
    VALUES (ay_id, '2025-2026', '2025-09-01', '2026-08-31', false);
  END IF;

  SELECT "id" INTO sem_id FROM "semesters"
  WHERE "academic_year_id" = ay_id AND "semester_number" = 2;
  IF sem_id IS NULL THEN
    sem_id := gen_random_uuid()::text;
    INSERT INTO "semesters"
      ("id", "academic_year_id", "name", "semester_number", "start_date", "end_date", "is_active", "is_closed")
    VALUES (sem_id, ay_id, 'Semester 2', 2, '2026-02-01', '2026-07-31', false, true);
  END IF;

  IF EXISTS (SELECT 1 FROM "special_exam_periods" WHERE "semester_id" = sem_id) THEN
    RAISE EXCEPTION '2025-2026 Semester 2 already has exam periods; not moving.';
  END IF;

  UPDATE "special_exam_periods"
  SET "academic_year_id" = ay_id,
      "semester_id" = sem_id,
      "name" = '2025-2026 — Semester 2 — ' ||
               CASE "phase" WHEN 'MIDTERM' THEN 'Midterm' ELSE 'Final' END
  WHERE "semester_id" = src_semester_id;
END $$;
