-- AlterTable
ALTER TABLE "daily_log_entries" ADD COLUMN     "leave_hours" DECIMAL(5,2);

-- CreateTable
CREATE TABLE "daily_log_entry_sessions" (
    "id" TEXT NOT NULL,
    "daily_log_entry_id" TEXT NOT NULL,
    "timetable_slot_id" TEXT,
    "course_name" TEXT NOT NULL,
    "class_name" TEXT NOT NULL,
    "start_time" TEXT NOT NULL,
    "end_time" TEXT NOT NULL,
    "hours" DECIMAL(5,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_log_entry_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "daily_log_entry_sessions_daily_log_entry_id_idx" ON "daily_log_entry_sessions"("daily_log_entry_id");

-- CreateIndex
CREATE INDEX "daily_log_entry_sessions_timetable_slot_id_idx" ON "daily_log_entry_sessions"("timetable_slot_id");

-- AddForeignKey
ALTER TABLE "daily_log_entry_sessions" ADD CONSTRAINT "daily_log_entry_sessions_daily_log_entry_id_fkey" FOREIGN KEY ("daily_log_entry_id") REFERENCES "daily_log_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_log_entry_sessions" ADD CONSTRAINT "daily_log_entry_sessions_timetable_slot_id_fkey" FOREIGN KEY ("timetable_slot_id") REFERENCES "timetable_slots"("id") ON DELETE SET NULL ON UPDATE CASCADE;
