-- "Share timetable to WhatsApp Group" for students — a MANUAL,
-- phone-number-less wa.me link (https://wa.me/?text=...) that opens
-- WhatsApp's own group/chat picker. The admin/dean picks the class's own
-- student WhatsApp group and sends manually; the app never learns which
-- group and sends nothing. Students still get ZERO automated WhatsApp.
--
-- Adds:
--   * class_timetable_shares — one row per (class, semester) recording
--     ONLY that it was shared (shared_at / shared_by_id), never the group.
--     Drives the "already shared … Share again" soft-block.
--   * a new AUTOMATIC event type + template row, CLASS_TIMETABLE_GROUP_SHARE,
--     seeded with the exact Somali text (byte-identical to
--     CLASS_TIMETABLE_GROUP_SHARE_DEFAULT in lib/whatsapp-templates.ts so
--     "Reset to default" agrees). isSystem = true: editable text, never
--     deletable.

-- CreateTable
CREATE TABLE "class_timetable_shares" (
    "id" TEXT NOT NULL,
    "class_id" TEXT NOT NULL,
    "semester_id" TEXT NOT NULL,
    "shared_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "shared_by_id" TEXT,

    CONSTRAINT "class_timetable_shares_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "class_timetable_shares_class_id_semester_id_key" ON "class_timetable_shares"("class_id", "semester_id");

-- CreateIndex
CREATE INDEX "class_timetable_shares_semester_id_idx" ON "class_timetable_shares"("semester_id");

-- AddForeignKey
ALTER TABLE "class_timetable_shares" ADD CONSTRAINT "class_timetable_shares_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_timetable_shares" ADD CONSTRAINT "class_timetable_shares_semester_id_fkey" FOREIGN KEY ("semester_id") REFERENCES "semesters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed the CLASS_TIMETABLE_GROUP_SHARE template — idempotent on event_key.
INSERT INTO "whatsapp_message_templates"
  ("id", "event_key", "name", "description", "trigger_kind", "is_system", "template_text", "updated_at")
SELECT
  gen_random_uuid()::text,
  'CLASS_TIMETABLE_GROUP_SHARE',
  'Class Timetable — Group Share',
  'Built by the "Share timetable to WhatsApp Group" button on the Timetable Builder — a wa.me link with NO phone number that opens WhatsApp''s group/chat picker so an admin/dean forwards a class''s finalized timetable to that class''s own student WhatsApp group. Manual, optional, no automated sending.',
  'AUTOMATIC',
  true,
  $ctgs$Salaan Ardayda {className},

Jadwalkaaga (Timetable) ee {semesterName} {academicYear} waa la diyaariyay.

Si aad u aragto, gal: {domainName}

Mahadsanid,
Maamulka Jaamacadda$ctgs$,
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM "whatsapp_message_templates" t WHERE t.event_key = 'CLASS_TIMETABLE_GROUP_SHARE'
);
