-- Daily Log: NOTE and PROBLEM entries can now optionally reference a
-- student (relatedStudentId), separate from the existing LEAVE_NOTICE-
-- only relatedLecturerId. Nullable, additive, no backfill.

-- AlterTable
ALTER TABLE "daily_log_entries" ADD COLUMN "related_student_id" TEXT;

-- AddForeignKey
ALTER TABLE "daily_log_entries" ADD CONSTRAINT "daily_log_entries_related_student_id_fkey" FOREIGN KEY ("related_student_id") REFERENCES "students"("id") ON DELETE SET NULL ON UPDATE CASCADE;
