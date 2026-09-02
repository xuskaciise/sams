-- "Timetable Ready" WhatsApp notification — a manual, per-lecturer (or
-- bulk-with-pacing) send telling a lecturer their timetable for a
-- semester is ready to view. COMPLETELY INDEPENDENT of Lecturer Login
-- Credentials: its own AUTOMATIC event type + template row (no username/
-- password placeholders), and its own per-(lecturer, semester)
-- sent-state table. Sent from Workload Import & Auto-Timetable by an
-- explicit admin/dean click. See lib/whatsapp-templates.ts and
-- CLAUDE.md's WhatsApp Notifications section.

-- CreateTable
CREATE TABLE "lecturer_timetable_notifications" (
    "id" TEXT NOT NULL,
    "lecturer_id" TEXT NOT NULL,
    "semester_id" TEXT NOT NULL,
    "notified_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notified_by_id" TEXT,

    CONSTRAINT "lecturer_timetable_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lecturer_timetable_notifications_lecturer_id_semester_id_key" ON "lecturer_timetable_notifications"("lecturer_id", "semester_id");

-- CreateIndex
CREATE INDEX "lecturer_timetable_notifications_semester_id_idx" ON "lecturer_timetable_notifications"("semester_id");

-- AddForeignKey
ALTER TABLE "lecturer_timetable_notifications" ADD CONSTRAINT "lecturer_timetable_notifications_lecturer_id_fkey" FOREIGN KEY ("lecturer_id") REFERENCES "lecturers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lecturer_timetable_notifications" ADD CONSTRAINT "lecturer_timetable_notifications_semester_id_fkey" FOREIGN KEY ("semester_id") REFERENCES "semesters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed the TIMETABLE_READY template row — idempotent on event_key, exact
-- Somali text (MUST stay byte-identical to TIMETABLE_READY_DEFAULT in
-- lib/whatsapp-templates.ts so "Reset to default" agrees). isSystem =
-- true: editable wording, never deletable.
INSERT INTO "whatsapp_message_templates"
  ("id", "event_key", "name", "description", "trigger_kind", "is_system", "template_text", "updated_at")
SELECT
  gen_random_uuid()::text,
  'TIMETABLE_READY',
  'Timetable Ready',
  'Sent to a lecturer, by an explicit per-lecturer or bulk click on Workload Import & Auto-Timetable, telling them their timetable for a semester is ready to view. Carries NO login credentials — fully separate from Lecturer Login Credentials.',
  'AUTOMATIC',
  true,
  $ttr$Salaan Macallin Sharaf leh,

Jadwalkaaga (Timetable) ee {semesterName} {academicYear} waa la diyaariyay.

Si aad u aragto, gal boggan: {domainName}

Haddii aad wax cilad ah la kulanto, fadlan la xariir Xafiiska Kulliyada.

Kulliyada: {facultyName}

Mahadsanid,
Maamulka Jaamacadda$ttr$,
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM "whatsapp_message_templates" t WHERE t.event_key = 'TIMETABLE_READY'
);
