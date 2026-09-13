-- Restructures Missed Exam Registration into two steps: an admin-defined
-- SpecialExamPeriod (one per academic-year+semester, "the container"),
-- and MissedExamRecord now belongs to one of those instead of carrying a
-- bare semester_id directly.
--
-- Defensive backfill: the prior migration (20260913000000) has not been
-- applied to any real database from this environment (no network
-- access, same constraint noted throughout CLAUDE.md's changelog), so
-- missed_exam_records almost certainly has zero rows anywhere this runs.
-- Handled properly anyway, in case it HAS already been deployed with
-- real rows: every distinct semester_id present gets its own backfilled
-- SpecialExamPeriod (name auto-composed exactly like the app would),
-- attributed to whichever user recorded the EARLIEST missed-exam row for
-- that semester (a real, traceable choice — never a fabricated system
-- user), before special_exam_period_id is populated and the old
-- semester_id column is dropped.

-- CreateTable
CREATE TABLE "special_exam_periods" (
    "id" TEXT NOT NULL,
    "academic_year_id" TEXT NOT NULL,
    "semester_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "special_exam_periods_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "special_exam_periods_academic_year_id_semester_id_key" ON "special_exam_periods"("academic_year_id", "semester_id");

-- AddForeignKey
ALTER TABLE "special_exam_periods" ADD CONSTRAINT "special_exam_periods_academic_year_id_fkey" FOREIGN KEY ("academic_year_id") REFERENCES "academic_years"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "special_exam_periods" ADD CONSTRAINT "special_exam_periods_semester_id_fkey" FOREIGN KEY ("semester_id") REFERENCES "semesters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "special_exam_periods" ADD CONSTRAINT "special_exam_periods_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Add the new (nullable-for-now) column on missed_exam_records
ALTER TABLE "missed_exam_records" ADD COLUMN "special_exam_period_id" TEXT;

-- Backfill: one SpecialExamPeriod per distinct semester_id already
-- referenced by an existing missed_exam_records row (a no-op on a fresh
-- database with zero rows, which is the expected case here).
INSERT INTO "special_exam_periods" ("id", "academic_year_id", "semester_id", "name", "is_active", "created_by", "created_at")
SELECT
  gen_random_uuid()::text,
  s.academic_year_id,
  s.id,
  ay.name || ' — ' || s.name,
  true,
  earliest.recorded_by,
  CURRENT_TIMESTAMP
FROM (
  SELECT DISTINCT ON (mer.semester_id) mer.semester_id, mer.recorded_by
  FROM "missed_exam_records" mer
  ORDER BY mer.semester_id, mer.recorded_at ASC
) AS earliest
JOIN "semesters" s ON s.id = earliest.semester_id
JOIN "academic_years" ay ON ay.id = s.academic_year_id
WHERE NOT EXISTS (
  SELECT 1 FROM "special_exam_periods" sep
  WHERE sep.academic_year_id = s.academic_year_id AND sep.semester_id = s.id
);

-- Point every existing record at its backfilled period
UPDATE "missed_exam_records" mer
SET "special_exam_period_id" = sep.id
FROM "special_exam_periods" sep
WHERE sep.semester_id = mer.semester_id
  AND mer."special_exam_period_id" IS NULL;

-- Drop the old semester_id column (FK + index go with it) now that every
-- row has a special_exam_period_id
ALTER TABLE "missed_exam_records" DROP CONSTRAINT "missed_exam_records_semester_id_fkey";
DROP INDEX "missed_exam_records_semester_id_idx";
ALTER TABLE "missed_exam_records" DROP COLUMN "semester_id";

-- Make the new column required and add its own FK + index
ALTER TABLE "missed_exam_records" ALTER COLUMN "special_exam_period_id" SET NOT NULL;
CREATE INDEX "missed_exam_records_special_exam_period_id_idx" ON "missed_exam_records"("special_exam_period_id");
ALTER TABLE "missed_exam_records" ADD CONSTRAINT "missed_exam_records_special_exam_period_id_fkey" FOREIGN KEY ("special_exam_period_id") REFERENCES "special_exam_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed the new exam.periods.manage permission (ADMIN only — Special Exam
-- Period is a university-wide setup concept, not faculty-specific; see
-- the "Special Exam Period management" business rule in CLAUDE.md).
-- Idempotent, same guarded-INSERT pattern as every prior permission-seed
-- migration.
INSERT INTO "permissions" ("id", "key", "description", "category")
SELECT gen_random_uuid()::text, 'exam.periods.manage',
  'Create and manage Special Exam Periods (per academic year + semester)',
  'Students'
WHERE NOT EXISTS (SELECT 1 FROM "permissions" WHERE "key" = 'exam.periods.manage');

INSERT INTO "role_permissions" ("id", "role_id", "permission_id")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "roles" r
JOIN "permissions" p ON p.key = 'exam.periods.manage'
WHERE r.name = 'ADMIN'
  AND r.is_system = true
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );
