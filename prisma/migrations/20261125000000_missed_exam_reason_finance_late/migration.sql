-- New missed-exam reason types. CHEATING / EMERGENCY stay in the enum as
-- legacy values for existing records; the UI no longer offers them.
ALTER TYPE "MissedExamReasonType" ADD VALUE IF NOT EXISTS 'FINANCE';
ALTER TYPE "MissedExamReasonType" ADD VALUE IF NOT EXISTS 'LATE';
