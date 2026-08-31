-- users.pending_credential — AES-256-GCM ciphertext of an account's
-- current admin-issued temp password, so the persistent "Send
-- credentials" action on Lecturer Accounts can re-send the SAME
-- still-valid credential without a password reset. See
-- lib/credential-crypto.ts and CLAUDE.md's WhatsApp Notifications
-- section. Additive/nullable; every pre-existing account stays null
-- (their temp password, if any, was never captured) and simply isn't
-- sendable from the table until an admin resets it.
ALTER TABLE "users" ADD COLUMN "pending_credential" TEXT;
