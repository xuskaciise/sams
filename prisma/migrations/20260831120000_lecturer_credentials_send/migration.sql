-- Lecturer login-credentials WhatsApp send:
--  * users.password_sent_at — tracks whether the CURRENT temp password
--    has already been sent (cleared on every reset); drives the
--    "already sent — resend not recommended" guard on Lecturer Accounts.
--  * whatsapp_settings.domain_name — the configurable login URL/host
--    shown in the credentials message ({domainName}), same for everyone.
--  * a new AUTOMATIC event type + template row, LECTURER_LOGIN_CREDENTIALS,
--    seeded with the exact Somali message text. AUTOMATIC (code-registered
--    hook in lib/whatsapp-templates.ts) even though it's sent by an
--    explicit admin click, not a passive trigger — its placeholder set is
--    fixed in code and it has a coded default to reset to, which a MANUAL
--    row can't have. isSystem = true: editable text, never deletable.

ALTER TABLE "users" ADD COLUMN "password_sent_at" TIMESTAMP(3);

ALTER TABLE "whatsapp_settings" ADD COLUMN "domain_name" TEXT;

INSERT INTO "whatsapp_message_templates"
  ("id", "event_key", "name", "description", "trigger_kind", "is_system", "template_text", "updated_at")
SELECT
  gen_random_uuid()::text,
  'LECTURER_LOGIN_CREDENTIALS',
  'Lecturer Login Credentials',
  'Sent to a lecturer from Lecturer Accounts after their login is generated — carries their username and one-time password.',
  'AUTOMATIC',
  true,
  $creds$Salaan Macallin Sharaf leh,

Waxaan kuu diyaarinay jadwalkaaga (Timetable) ee sanad-dugsiyeedka cusub {academicYear}, {semesterName}.

Si aad jadwalkaaga u aragto, fadlan gal boggan:
🔗 Domain: {domainName}

Xogta gelitaanka (Login):
👤 Username: {username}
🔒 Password: {tempPassword}

Marka aad markii ugu horreysa gasho, waxaa lagaa qasbi doonaa inaad password-kaaga beddesho.

Haddii aad wax cilad ah la kulanto, fadlan la xariir Xafiiska Kulliyada (Faculty Office).

Kulliyada: {facultyName}

Mahadsanid,
Maamulka Jaamacadda$creds$,
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM "whatsapp_message_templates" t WHERE t.event_key = 'LECTURER_LOGIN_CREDENTIALS'
);
