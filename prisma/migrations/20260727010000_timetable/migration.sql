-- Class Timetable: Room + TimetableSlot, scheduling course + lecturer +
-- day + time + room per LecturerCourseAssignment (course/class/semester
-- already resolved through the assignment). startTime/endTime are
-- zero-padded "HH:MM" text, not a DB TIME column (see schema.prisma
-- comment on TimetableSlot). Conflict-free-ness is enforced in
-- application code, not a DB constraint.

-- CreateEnum
CREATE TYPE "DayOfWeek" AS ENUM ('MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT');

-- CreateTable
CREATE TABLE "rooms" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "capacity" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "rooms_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rooms_name_key" ON "rooms"("name");

-- CreateTable
CREATE TABLE "timetable_slots" (
    "id" TEXT NOT NULL,
    "lecturer_course_assignment_id" TEXT NOT NULL,
    "day_of_week" "DayOfWeek" NOT NULL,
    "start_time" TEXT NOT NULL,
    "end_time" TEXT NOT NULL,
    "room_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "timetable_slots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "timetable_slots_lecturer_course_assignment_id_idx" ON "timetable_slots"("lecturer_course_assignment_id");
CREATE INDEX "timetable_slots_room_id_idx" ON "timetable_slots"("room_id");
CREATE INDEX "timetable_slots_day_of_week_idx" ON "timetable_slots"("day_of_week");

-- AddForeignKey
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_lecturer_course_assignment_id_fkey" FOREIGN KEY ("lecturer_course_assignment_id") REFERENCES "lecturer_course_assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
