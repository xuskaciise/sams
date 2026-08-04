-- Room assignment moves from a scheduling-time choice to a
-- class-registration property: Class gains a single default room, set at
-- class create/edit time (Academic Structure > Classes), and both the
-- drag-and-drop Build Timetable and the auto-timetable generator read it
-- directly instead of asking for a room per build/generate session. See
-- CLAUDE.md's "Class Timetable" business rule for the full reasoning.
ALTER TABLE "classes" ADD COLUMN "room_id" TEXT;

ALTER TABLE "classes" ADD CONSTRAINT "classes_room_id_fkey"
  FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill from existing TimetableSlot data where it can be determined
-- UNAMBIGUOUSLY: a class whose sessions all use exactly ONE room gets that
-- room as its new roomId. A class with NO existing sessions, or with
-- sessions spanning MORE than one room, is deliberately left NULL here —
-- never guessed — for an admin to set manually via the Classes form.
UPDATE "classes" c
SET "room_id" = sub.room_id
FROM (
  SELECT lca.class_id AS class_id, MIN(ts.room_id) AS room_id
  FROM "timetable_slots" ts
  JOIN "lecturer_course_assignments" lca ON lca.id = ts.lecturer_course_assignment_id
  GROUP BY lca.class_id
  HAVING COUNT(DISTINCT ts.room_id) = 1
) sub
WHERE c.id = sub.class_id;
