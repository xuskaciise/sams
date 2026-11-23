-- A semester now has two parts: Midterm and Final.
--   * Every assessment belongs to one part; existing rows become MIDTERM.
--   * Every Special Exam Period covers one part. Each existing period
--     becomes the MIDTERM period of its semester, a FINAL sibling is
--     created next to it, and existing missed-exam records are moved so a
--     record's exam_type always matches its period's phase:
--       FINAL -> moved to the FINAL period
--       BOTH  -> split into one MIDTERM row (kept) + one FINAL row (copied)

-- CreateEnum
CREATE TYPE "ExamPhase" AS ENUM ('MIDTERM', 'FINAL');

-- Assessments
ALTER TABLE "assessments" ADD COLUMN "exam_phase" "ExamPhase" NOT NULL DEFAULT 'MIDTERM';

-- Special exam periods: existing periods become MIDTERM. The old
-- one-per-semester index goes first so the FINAL sibling can be inserted.
DROP INDEX "special_exam_periods_academic_year_id_semester_id_key";
ALTER TABLE "special_exam_periods" ADD COLUMN "phase" "ExamPhase";
UPDATE "special_exam_periods"
SET "phase" = 'MIDTERM', "name" = "name" || ' — Midterm';

-- A FINAL sibling for every existing period (same year/semester/status/creator)
INSERT INTO "special_exam_periods"
  ("id", "academic_year_id", "semester_id", "name", "phase", "status", "created_by", "created_at")
SELECT gen_random_uuid()::text, p."academic_year_id", p."semester_id",
       regexp_replace(p."name", ' — Midterm$', '') || ' — Final',
       'FINAL', p."status", p."created_by", p."created_at"
FROM "special_exam_periods" p
WHERE p."phase" = 'MIDTERM';

-- FINAL records move to the FINAL sibling
UPDATE "missed_exam_records" r
SET "special_exam_period_id" = f."id"
FROM "special_exam_periods" m
JOIN "special_exam_periods" f
  ON f."academic_year_id" = m."academic_year_id"
 AND f."semester_id" = m."semester_id"
 AND f."phase" = 'FINAL'
WHERE r."special_exam_period_id" = m."id"
  AND m."phase" = 'MIDTERM'
  AND r."exam_type" = 'FINAL';

-- BOTH records: copy a FINAL row into the FINAL sibling...
INSERT INTO "missed_exam_records"
  ("id", "student_id", "course_id", "special_exam_period_id", "exam_type",
   "reason_type", "reason_note", "recorded_by", "recorded_at")
SELECT gen_random_uuid()::text, r."student_id", r."course_id", f."id", 'FINAL',
       r."reason_type", r."reason_note", r."recorded_by", r."recorded_at"
FROM "missed_exam_records" r
JOIN "special_exam_periods" m ON m."id" = r."special_exam_period_id"
JOIN "special_exam_periods" f
  ON f."academic_year_id" = m."academic_year_id"
 AND f."semester_id" = m."semester_id"
 AND f."phase" = 'FINAL'
WHERE r."exam_type" = 'BOTH' AND m."phase" = 'MIDTERM';

-- ...and keep the original as the MIDTERM row
UPDATE "missed_exam_records" SET "exam_type" = 'MIDTERM' WHERE "exam_type" = 'BOTH';

ALTER TABLE "special_exam_periods" ALTER COLUMN "phase" SET NOT NULL;

-- One period per year + semester + phase
CREATE UNIQUE INDEX "special_exam_periods_academic_year_id_semester_id_phase_key"
  ON "special_exam_periods"("academic_year_id", "semester_id", "phase");
