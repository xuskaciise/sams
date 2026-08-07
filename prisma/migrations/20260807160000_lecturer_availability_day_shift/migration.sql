-- Upgrade lecturer availability from day-only (Lecturer.available_days
-- DayOfWeek[]) to day+shift granularity (lecturer_availability join
-- table). Availability is re-entered fresh every auto-generate cycle via
-- the wizard (see CLAUDE.md's "Lecturer availableDays" business rule),
-- so the 53 existing non-null values being dropped here are stale
-- values from prior runs, not permanent data — nothing is lost that the
-- next generation cycle wouldn't ask for again anyway.

-- AlterTable
ALTER TABLE "lecturers" DROP COLUMN "available_days";

-- CreateTable
CREATE TABLE "lecturer_availability" (
    "id" TEXT NOT NULL,
    "lecturer_id" TEXT NOT NULL,
    "day_of_week" "DayOfWeek" NOT NULL,
    "shift_id" TEXT,

    CONSTRAINT "lecturer_availability_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lecturer_availability_lecturer_id_idx" ON "lecturer_availability"("lecturer_id");

-- CreateIndex
CREATE INDEX "lecturer_availability_shift_id_idx" ON "lecturer_availability"("shift_id");

-- CreateIndex
CREATE UNIQUE INDEX "lecturer_availability_lecturer_id_day_of_week_shift_id_key" ON "lecturer_availability"("lecturer_id", "day_of_week", "shift_id");

-- AddForeignKey
ALTER TABLE "lecturer_availability" ADD CONSTRAINT "lecturer_availability_lecturer_id_fkey" FOREIGN KEY ("lecturer_id") REFERENCES "lecturers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lecturer_availability" ADD CONSTRAINT "lecturer_availability_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
