-- CreateTable
CREATE TABLE "whatsapp_message_templates" (
    "id" TEXT NOT NULL,
    "event_type" "WhatsAppEventType" NOT NULL,
    "template_text" TEXT NOT NULL,
    "updated_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_message_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_message_templates_event_type_key" ON "whatsapp_message_templates"("event_type");

-- AddForeignKey
ALTER TABLE "whatsapp_message_templates" ADD CONSTRAINT "whatsapp_message_templates_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seeds notification.templates.manage (mirrors lib/permissions.ts),
-- granted to ADMIN only — same reasoning as whatsapp.manage/campus.manage
-- /room.manage/shift.manage: centrally administered, not a per-faculty
-- concern. Idempotent, same guard pattern as every prior permission-seed
-- migration.
INSERT INTO "permissions" ("id", "key", "description", "category")
SELECT gen_random_uuid()::text, v.key, v.description, v.category
FROM (VALUES
  ('notification.templates.manage', 'Edit WhatsApp notification message templates', 'Integrations')
) AS v(key, description, category)
WHERE NOT EXISTS (SELECT 1 FROM "permissions" p WHERE p.key = v.key);

INSERT INTO "role_permissions" ("id", "role_id", "permission_id")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "roles" r
JOIN "permissions" p ON p.key = 'notification.templates.manage'
WHERE r.name = 'ADMIN'
  AND r.is_system = true
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );

-- Seeds one default row per WhatsAppEventType, with the EXACT text each
-- trigger hardcoded before this table existed (see
-- lib/whatsapp-templates.ts's DEFAULT_WHATSAPP_TEMPLATES — must stay
-- byte-identical to these literals) — so nothing about an outgoing
-- message changes until an admin deliberately edits one. updated_by is
-- left NULL (no admin has touched these yet). Idempotent on event_type.
INSERT INTO "whatsapp_message_templates" ("id", "event_type", "template_text", "updated_at")
SELECT gen_random_uuid()::text, v.event_type::"WhatsAppEventType", v.template_text, CURRENT_TIMESTAMP
FROM (VALUES
  ('RESULTS_PUBLISHED', 'Hello {studentName}, your results for {courseName} ({assessmentTitle}) have been published. Check the SAMS student portal for details.'),
  ('LEAVE_NOTICE', '{title} ({date}){description}'),
  ('TIMETABLE_CHANGE', 'Hello {studentName}, {changeSummary}')
) AS v(event_type, template_text)
WHERE NOT EXISTS (
  SELECT 1 FROM "whatsapp_message_templates" t WHERE t.event_type = v.event_type::"WhatsAppEventType"
);
