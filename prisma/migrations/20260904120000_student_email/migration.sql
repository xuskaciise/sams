-- Email as a channel for students:
--   * students.email — optional real address (distinct from the synthetic
--     studentNo@students.sams.local login email on users.email). When set:
--     automatic credential delivery on account generation + automatic
--     results-published notifications. When absent: existing fallbacks.
--   * whatsapp_message_templates.subject — the subject line for the two
--     EMAIL-channel automatic events (null for every WhatsApp/wa.me event).
--   * email_logs — outcome record for every real automated email attempt
--     (Resend, synchronous — no queue/worker). SENT / FAILED / SKIPPED.
--   * two new AUTOMATIC, isSystem template rows for the email events,
--     seeded with subject + body (byte-identical to the *_EMAIL_DEFAULT /
--     *_EMAIL_SUBJECT literals in lib/whatsapp-templates.ts so "Reset to
--     default" and a fresh seed agree).

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('SENT', 'FAILED', 'SKIPPED');

-- AlterTable
ALTER TABLE "students" ADD COLUMN "email" TEXT;

-- AlterTable
ALTER TABLE "whatsapp_message_templates" ADD COLUMN "subject" TEXT;

-- CreateTable
CREATE TABLE "email_logs" (
    "id" TEXT NOT NULL,
    "recipient_type" TEXT NOT NULL,
    "recipient_id" TEXT NOT NULL,
    "recipient_email" TEXT,
    "event_key" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" "EmailStatus" NOT NULL,
    "error" TEXT,
    "entity" TEXT NOT NULL,
    "entity_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_logs_recipient_type_recipient_id_idx" ON "email_logs"("recipient_type", "recipient_id");

-- CreateIndex
CREATE INDEX "email_logs_event_key_idx" ON "email_logs"("event_key");

-- CreateIndex
CREATE INDEX "email_logs_created_at_idx" ON "email_logs"("created_at");

-- Seed the two EMAIL-channel template rows (idempotent on event_key).
INSERT INTO "whatsapp_message_templates"
  ("id", "event_key", "name", "description", "trigger_kind", "is_system", "subject", "template_text", "updated_at")
SELECT
  gen_random_uuid()::text,
  'STUDENT_LOGIN_CREDENTIALS_EMAIL',
  'Student Login Credentials (Email)',
  'Emailed automatically to a student when their account is generated, IF they have a real email on file. Carries the username + one-time password. No email on file -> falls back to the CSV / one-time on-screen reveal.',
  'AUTOMATIC',
  true,
  'Xogta gelitaanka SAMS — {studentName}',
  $scemail$Salaan {studentName},

Waxaa laguu sameeyay akoon SAMS ah (Student No: {studentNo}).

Xogta gelitaanka (Login):
Username: {username}
Password: {tempPassword}

Fadlan gal: {domainName}
Marka aad markii ugu horreysa gasho, waxaa lagaa qasbi doonaa inaad password-kaaga beddesho.

Mahadsanid,
Maamulka Jaamacadda$scemail$,
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM "whatsapp_message_templates" t WHERE t.event_key = 'STUDENT_LOGIN_CREDENTIALS_EMAIL'
);

INSERT INTO "whatsapp_message_templates"
  ("id", "event_key", "name", "description", "trigger_kind", "is_system", "subject", "template_text", "updated_at")
SELECT
  gen_random_uuid()::text,
  'RESULTS_PUBLISHED_EMAIL',
  'Results Published (Email)',
  'Emailed automatically to every affected student who has a real email on file when a lecturer publishes an assessment. Deliberately carries NO mark — directs the student to log in and view it.',
  'AUTOMATIC',
  true,
  'Natiijadaada waa la daabacay — {courseName}',
  $rpemail$Salaan {studentName},

Natiijada imtixaanka "{assessmentTitle}" ee maaddada {courseName} ({className}, {semesterName}) hadda waa la heli karaa.

Si aad u aragto, fadlan gal: {domainName}

Mahadsanid,
Maamulka Jaamacadda$rpemail$,
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM "whatsapp_message_templates" t WHERE t.event_key = 'RESULTS_PUBLISHED_EMAIL'
);
