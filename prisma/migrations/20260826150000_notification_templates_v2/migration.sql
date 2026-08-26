-- Notification templates v2: event types become admin-extensible
-- (AUTOMATIC tied to an existing code hook, or MANUAL for on-demand
-- sending), and WhatsAppMessageTemplate/WhatsAppNotificationLog switch
-- from the fixed WhatsAppEventType enum to a free eventKey string. See
-- CLAUDE.md's WhatsApp Notifications section and the schema.prisma
-- comments on both models for the full design.

-- CreateEnum
CREATE TYPE "WhatsAppTriggerKind" AS ENUM ('AUTOMATIC', 'MANUAL');

-- ============================================================
-- whatsapp_message_templates: event_type (enum) -> event_key (text),
-- plus name/description/trigger_kind/is_system/deleted_at.
-- ============================================================

ALTER TABLE "whatsapp_message_templates"
  ADD COLUMN "event_key" TEXT,
  ADD COLUMN "name" TEXT,
  ADD COLUMN "description" TEXT,
  ADD COLUMN "trigger_kind" "WhatsAppTriggerKind" NOT NULL DEFAULT 'AUTOMATIC',
  ADD COLUMN "is_system" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "deleted_at" TIMESTAMP(3);

-- Backfill: the only rows that can exist at this point are the 3 original
-- built-ins (seeded by the whatsapp_message_templates migration) — every
-- one of them is AUTOMATIC and system-protected. event_key/name are
-- byte-identical to lib/whatsapp-event-registry.ts's AUTOMATIC_EVENTS
-- keys/labels, so nothing about how these rows resolve at runtime changes.
UPDATE "whatsapp_message_templates"
SET
  "event_key" = "event_type"::text,
  "is_system" = true,
  "name" = CASE "event_type"::text
    WHEN 'RESULTS_PUBLISHED' THEN 'Results published'
    WHEN 'LEAVE_NOTICE' THEN 'Leave notice'
    WHEN 'TIMETABLE_CHANGE' THEN 'Timetable change'
    ELSE "event_type"::text
  END;

-- A fresh (pre-seed) database has zero rows here — nothing to backfill,
-- and the later INSERT below seeds the 3 built-ins directly with every
-- column already populated, so the NOT NULL below is safe either way.
ALTER TABLE "whatsapp_message_templates"
  ALTER COLUMN "event_key" SET NOT NULL,
  ALTER COLUMN "name" SET NOT NULL;

DROP INDEX "whatsapp_message_templates_event_type_key";
ALTER TABLE "whatsapp_message_templates" DROP COLUMN "event_type";
CREATE UNIQUE INDEX "whatsapp_message_templates_event_key_key" ON "whatsapp_message_templates"("event_key");

-- ============================================================
-- whatsapp_notification_logs: event_type (enum) -> event_key (text).
-- Past deliveries keep their original key string verbatim (no FK to
-- WhatsAppMessageTemplate — see that model's schema comment).
-- ============================================================

ALTER TABLE "whatsapp_notification_logs" ADD COLUMN "event_key" TEXT;
UPDATE "whatsapp_notification_logs" SET "event_key" = "event_type"::text;
ALTER TABLE "whatsapp_notification_logs"
  ALTER COLUMN "event_key" SET NOT NULL,
  DROP COLUMN "event_type";

-- Nothing references WhatsAppEventType anymore.
DROP TYPE "WhatsAppEventType";

-- Ensures the 3 built-in AUTOMATIC templates exist with the new columns
-- populated even on a database that never had the whatsapp_message_templates
-- migration's rows for some reason (defensive; on a normally-migrated
-- database the UPDATE above already covers them and this is a no-op).
INSERT INTO "whatsapp_message_templates" ("id", "event_key", "name", "trigger_kind", "is_system", "template_text", "updated_at")
SELECT gen_random_uuid()::text, v.event_key, v.name, 'AUTOMATIC', true, v.template_text, CURRENT_TIMESTAMP
FROM (VALUES
  ('RESULTS_PUBLISHED', 'Results published', 'Hello {studentName}, your results for {courseName} ({assessmentTitle}) have been published. Check the SAMS student portal for details.'),
  ('LEAVE_NOTICE', 'Leave notice', '{title} ({date}){description}'),
  ('TIMETABLE_CHANGE', 'Timetable change', 'Hello {studentName}, {changeSummary}')
) AS v(event_key, name, template_text)
WHERE NOT EXISTS (
  SELECT 1 FROM "whatsapp_message_templates" t WHERE t.event_key = v.event_key
);

-- Seeds notification.send.manual (mirrors lib/permissions.ts), granted to
-- ADMIN, DEAN (faculty-scoped, dean_departments), and LECTURER (own
-- course-assignment-scoped) by default — never STUDENT. Idempotent, same
-- guard pattern as every prior permission-seed migration.
INSERT INTO "permissions" ("id", "key", "description", "category")
SELECT gen_random_uuid()::text, v.key, v.description, v.category
FROM (VALUES
  ('notification.send.manual', 'Send an ad-hoc WhatsApp notification using a manual template', 'Integrations')
) AS v(key, description, category)
WHERE NOT EXISTS (SELECT 1 FROM "permissions" p WHERE p.key = v.key);

INSERT INTO "role_permissions" ("id", "role_id", "permission_id")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "roles" r
JOIN "permissions" p ON p.key = 'notification.send.manual'
WHERE r.name IN ('ADMIN', 'DEAN', 'LECTURER')
  AND r.is_system = true
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );
