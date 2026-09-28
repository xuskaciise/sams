import { timingSafeEqual } from "crypto";
import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { encryptCredential } from "@/lib/credential-crypto";
import { createBackupFolder, exchangeCodeForTokens } from "@/lib/google-drive";
import { STATE_COOKIE, redirectToDashboard } from "../oauth";

function statesMatch(a: string | undefined, b: string | null): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// Google redirects here after consent. The lecturer's SAMS session cookie
// comes along (sameSite=lax, top-level GET), so this is the same
// requirePermission boundary as every Server Action — the connection is
// always stored against the SESSION's own lecturer, never anything taken
// from the query string.
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  let userId: string;
  try {
    userId = (await requirePermission("drive.backup")).id;
  } catch {
    return redirectToDashboard(request.url, "forbidden");
  }

  if (!statesMatch(request.cookies.get(STATE_COOKIE)?.value, params.get("state"))) {
    return redirectToDashboard(request.url, "error");
  }
  if (params.get("error")) {
    return redirectToDashboard(request.url, "denied");
  }
  const code = params.get("code");
  if (!code) {
    return redirectToDashboard(request.url, "error");
  }

  const lecturer = await prisma.lecturer.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (!lecturer) {
    return redirectToDashboard(request.url, "forbidden");
  }

  try {
    const { accessToken, refreshToken } = await exchangeCodeForTokens(code);
    if (!refreshToken) {
      return redirectToDashboard(request.url, "error");
    }
    const accessTokenEncrypted = encryptCredential(accessToken);
    const refreshTokenEncrypted = encryptCredential(refreshToken);
    if (!accessTokenEncrypted || !refreshTokenEncrypted) {
      return redirectToDashboard(request.url, "unavailable");
    }

    // Reuse a previous folder id on reconnect; runDriveBackup verifies it
    // is still usable and creates a fresh one if not.
    const existing = await prisma.lecturerGoogleDriveConnection.findUnique({
      where: { lecturerId: lecturer.id },
      select: { driveFolderId: true },
    });
    const driveFolderId =
      existing?.driveFolderId ?? (await createBackupFolder(accessToken));

    const now = new Date();
    const data = {
      accessTokenEncrypted,
      refreshTokenEncrypted,
      driveFolderId,
      connectedAt: now,
      needsReconnect: false,
      lastErrorMessage: null,
      lastBackupStatus: "PENDING" as const,
      // First backup on the scheduler's next tick.
      backupDueAt: now,
    };
    await prisma.lecturerGoogleDriveConnection.upsert({
      where: { lecturerId: lecturer.id },
      create: { lecturerId: lecturer.id, ...data },
      update: data,
    });

    await audit({
      userId,
      action: "GOOGLE_DRIVE_CONNECTED",
      entity: "Lecturer",
      entityId: lecturer.id,
      newValue: { reconnected: existing !== null },
    });
  } catch (error) {
    console.error("[google-drive] callback failed", error);
    return redirectToDashboard(request.url, "error");
  }

  return redirectToDashboard(request.url, "connected");
}
