"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { decryptCredential } from "@/lib/credential-crypto";
import { revokeToken } from "@/lib/google-drive";

// Lecturer Google Drive backup — dashboard card actions. Both operate on
// the SESSION's own lecturer only (the query IS the ownership check).

async function ownConnection(userId: string) {
  return prisma.lecturerGoogleDriveConnection.findFirst({
    where: { lecturer: { userId } },
  });
}

// Deletes the stored tokens/connection, then revokes the grant at Google
// (best effort — a failure there never blocks the local disconnect). The
// backup file itself stays in the lecturer's Drive; it's theirs.
export async function disconnectGoogleDrive(): Promise<void> {
  const user = await requirePermission("drive.backup");
  const connection = await ownConnection(user.id);
  if (!connection) return;

  await prisma.lecturerGoogleDriveConnection.delete({ where: { id: connection.id } });

  const refreshToken = decryptCredential(connection.refreshTokenEncrypted);
  if (refreshToken) {
    await revokeToken(refreshToken).catch(() => undefined);
  }

  await audit({
    userId: user.id,
    action: "GOOGLE_DRIVE_DISCONNECTED",
    entity: "Lecturer",
    entityId: connection.lecturerId,
  });
  revalidatePath("/");
}

// "Back up now": makes the backup due immediately — the scheduler picks it
// up within a minute. The upload never runs inside this request.
export async function requestDriveBackupNow(): Promise<void> {
  const user = await requirePermission("drive.backup");
  const connection = await ownConnection(user.id);
  if (!connection) throw new Error("NOT_FOUND");
  if (connection.needsReconnect) throw new Error("NEEDS_RECONNECT");

  await prisma.lecturerGoogleDriveConnection.update({
    where: { id: connection.id },
    data: { backupDueAt: new Date(), lastBackupStatus: "PENDING" },
  });
  revalidatePath("/");
}
