-- Lecturer Google Drive backup: connection table + the drive.backup permission (LECTURER).
-- CreateEnum
CREATE TYPE "DriveBackupStatus" AS ENUM ('SUCCESS', 'FAILED', 'PENDING');

-- CreateTable
CREATE TABLE "lecturer_google_drive_connections" (
    "id" TEXT NOT NULL,
    "lecturer_id" TEXT NOT NULL,
    "access_token_encrypted" TEXT NOT NULL,
    "refresh_token_encrypted" TEXT NOT NULL,
    "drive_file_id" TEXT,
    "drive_folder_id" TEXT,
    "connected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_backup_at" TIMESTAMP(3),
    "last_backup_status" "DriveBackupStatus",
    "last_error_message" TEXT,
    "backup_due_at" TIMESTAMP(3),
    "last_attempt_at" TIMESTAMP(3),
    "needs_reconnect" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "lecturer_google_drive_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lecturer_google_drive_connections_lecturer_id_key" ON "lecturer_google_drive_connections"("lecturer_id");

-- CreateIndex
CREATE INDEX "lecturer_google_drive_connections_backup_due_at_idx" ON "lecturer_google_drive_connections"("backup_due_at");

-- AddForeignKey
ALTER TABLE "lecturer_google_drive_connections" ADD CONSTRAINT "lecturer_google_drive_connections_lecturer_id_fkey" FOREIGN KEY ("lecturer_id") REFERENCES "lecturers"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Seeds drive.backup (mirrors lib/permissions.ts), granted to LECTURER.
-- Idempotent, same guarded-INSERT pattern as every prior permission seed.
INSERT INTO "permissions" ("id", "key", "description", "category")
SELECT gen_random_uuid()::text, 'drive.backup',
  'Connect your own Google Drive and back up your own assessment marks to it',
  'Integrations'
WHERE NOT EXISTS (SELECT 1 FROM "permissions" WHERE "key" = 'drive.backup');

INSERT INTO "role_permissions" ("id", "role_id", "permission_id")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "roles" r
JOIN "permissions" p ON p.key = 'drive.backup'
WHERE r.name = 'LECTURER'
  AND r.is_system = true
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );
