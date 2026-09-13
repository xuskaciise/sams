-- Special Exam Period gains a proper Open/Closed status, replacing what
-- used to be a plain `is_active` boolean with the exact same meaning
-- ("open for new registrations vs. closed" — see the SpecialExamPeriod
-- model comment in schema.prisma). Converting the existing column rather
-- than adding a second, overlapping one: `is_active` already WAS this
-- concept, just mislabeled and only ever enforced client-side (Form 2's
-- period picker); this migration keeps it as one field, renamed and
-- retyped, now also enforced server-side in recordMissedExamsBulk.

CREATE TYPE "SpecialExamPeriodStatus" AS ENUM ('OPEN', 'CLOSED');

-- New column, defaulting OPEN so a concurrent insert mid-migration still
-- lands correctly without needing the backfill step below.
ALTER TABLE "special_exam_periods"
  ADD COLUMN "status" "SpecialExamPeriodStatus" NOT NULL DEFAULT 'OPEN';

-- Backfill: every existing row's `is_active = false` becomes CLOSED;
-- `is_active = true` rows already default to OPEN, nothing to do for them.
UPDATE "special_exam_periods" SET "status" = 'CLOSED' WHERE "is_active" = false;

ALTER TABLE "special_exam_periods" DROP COLUMN "is_active";
