-- Faculty Daily Log: notes/leave notices/problems logged by Admin or Dean
-- against a faculty (Department). departmentId ties each entry to a
-- faculty; relatedLecturerId is set for LEAVE_NOTICE entries.

-- CreateEnum
CREATE TYPE "DailyLogType" AS ENUM ('LEAVE_NOTICE', 'PROBLEM', 'NOTE');

-- CreateTable
CREATE TABLE "daily_log_entries" (
    "id" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "type" "DailyLogType" NOT NULL,
    "related_lecturer_id" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "entry_date" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_log_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "daily_log_entries_department_id_idx" ON "daily_log_entries"("department_id");
CREATE INDEX "daily_log_entries_entry_date_idx" ON "daily_log_entries"("entry_date");

-- AddForeignKey
ALTER TABLE "daily_log_entries" ADD CONSTRAINT "daily_log_entries_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "daily_log_entries" ADD CONSTRAINT "daily_log_entries_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "daily_log_entries" ADD CONSTRAINT "daily_log_entries_related_lecturer_id_fkey" FOREIGN KEY ("related_lecturer_id") REFERENCES "lecturers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
