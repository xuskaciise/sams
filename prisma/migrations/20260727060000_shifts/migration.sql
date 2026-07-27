-- Shift: reusable time-of-day templates scoped to a studyMode (FT/PT),
-- used purely as a data-entry convenience for Timetable session times.
-- No relation to timetable_slots at all — a shift pick just copies its
-- start/end time into the form.

CREATE TABLE "shifts" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "study_mode" "StudyMode" NOT NULL,
    "start_time" TEXT NOT NULL,
    "end_time" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shifts_study_mode_name_key" ON "shifts"("study_mode", "name");
