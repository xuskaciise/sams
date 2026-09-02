-- "Share via WhatsApp" (wa.me manual link) replaces the automated Baileys
-- send for LECTURER_LOGIN_CREDENTIALS and TIMETABLE_READY only. There is
-- no server-side delivery confirmation with a manual link, so the
-- tracking fields are renamed from "...sent/notified..." to
-- "...link opened..." — the app only knows the admin OPENED the link,
-- not that they hit Send inside WhatsApp. Pure column renames — data is
-- preserved. Leave-notice / results / timetable-change sending is
-- unchanged (still the Baileys worker).

ALTER TABLE "users" RENAME COLUMN "password_sent_at" TO "credentials_link_opened_at";

ALTER TABLE "lecturer_timetable_notifications" RENAME COLUMN "notified_at" TO "link_opened_at";
ALTER TABLE "lecturer_timetable_notifications" RENAME COLUMN "notified_by_id" TO "opened_by_id";
