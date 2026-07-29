-- WhatsApp Notifications: best-effort, unofficial, entirely optional
-- (see CLAUDE.md and lib/whatsapp-notify.ts). Adds an optional phone
-- number to Student/Lecturer, the notification outbox/log table, the
-- single-row settings table (feature on/off + live connection status
-- written by the separate VPS worker process), and seeds the
-- whatsapp.manage permission (ADMIN only). Purely additive — no
-- existing column, table, or row is touched.

-- CreateEnum
CREATE TYPE "WhatsAppEventType" AS ENUM ('RESULTS_PUBLISHED', 'LEAVE_NOTICE', 'TIMETABLE_CHANGE');

-- CreateEnum
CREATE TYPE "WhatsAppNotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- AlterTable
ALTER TABLE "lecturers" ADD COLUMN     "phone_number" TEXT;

-- AlterTable
ALTER TABLE "students" ADD COLUMN     "phone_number" TEXT;

-- CreateTable
CREATE TABLE "whatsapp_notification_logs" (
    "id" TEXT NOT NULL,
    "recipient_type" TEXT NOT NULL,
    "recipient_id" TEXT NOT NULL,
    "recipient_name" TEXT NOT NULL,
    "phone_number" TEXT NOT NULL,
    "event_type" "WhatsAppEventType" NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" TEXT,
    "message" TEXT NOT NULL,
    "status" "WhatsAppNotificationStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "sent_at" TIMESTAMP(3),

    CONSTRAINT "whatsapp_notification_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_settings" (
    "id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "connection_status" TEXT NOT NULL DEFAULT 'DISCONNECTED',
    "last_heartbeat_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "whatsapp_notification_logs_status_idx" ON "whatsapp_notification_logs"("status");

-- CreateIndex
CREATE INDEX "whatsapp_notification_logs_recipient_type_recipient_id_idx" ON "whatsapp_notification_logs"("recipient_type", "recipient_id");

-- CreateIndex
CREATE INDEX "whatsapp_notification_logs_created_at_idx" ON "whatsapp_notification_logs"("created_at");

-- Exactly one settings row, id = 'singleton' (see WHATSAPP_SETTINGS_ID in
-- lib/whatsapp-notify.ts). Starts disabled and DISCONNECTED — an admin
-- must explicitly opt in, and the VPS worker overwrites connection_status
-- once it's actually running and QR-scanned.
INSERT INTO "whatsapp_settings" ("id", "enabled", "connection_status", "updated_at")
VALUES ('singleton', false, 'DISCONNECTED', CURRENT_TIMESTAMP)
ON CONFLICT DO NOTHING;

-- Seed whatsapp.manage (mirrors lib/permissions.ts), granted to ADMIN
-- only — same centrally-administered reasoning as campus.manage/
-- room.manage/shift.manage. Idempotent, same guard pattern as every
-- prior permission-seed migration in this app.
INSERT INTO "permissions" ("id", "key", "description", "category")
SELECT gen_random_uuid()::text, v.key, v.description, v.category
FROM (VALUES
  ('whatsapp.manage', 'Enable/disable WhatsApp notifications, view delivery status, and retry failed sends', 'Integrations')
) AS v(key, description, category)
WHERE NOT EXISTS (SELECT 1 FROM "permissions" p WHERE p.key = v.key);

INSERT INTO "role_permissions" ("id", "role_id", "permission_id")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "roles" r
JOIN "permissions" p ON p.key = 'whatsapp.manage'
WHERE r.name = 'ADMIN'
  AND r.is_system = true
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );
