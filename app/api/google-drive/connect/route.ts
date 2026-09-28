import { randomBytes } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { credentialStoreConfigured } from "@/lib/credential-crypto";
import { buildGoogleAuthUrl, driveConfigured } from "@/lib/google-drive";
import { STATE_COOKIE, STATE_COOKIE_PATH, redirectToDashboard } from "../oauth";

// Starts the lecturer's own Google Drive connection: a random state value
// (CSRF guard, checked by the callback) in a short-lived httpOnly cookie,
// then a redirect to Google's consent screen (drive.file scope, offline).
export async function GET(request: NextRequest) {
  let userId: string;
  try {
    userId = (await requirePermission("drive.backup")).id;
  } catch {
    return redirectToDashboard(request.url, "forbidden");
  }

  if (!driveConfigured() || !credentialStoreConfigured()) {
    return redirectToDashboard(request.url, "unavailable");
  }

  const lecturer = await prisma.lecturer.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (!lecturer) {
    return redirectToDashboard(request.url, "forbidden");
  }

  const state = randomBytes(24).toString("base64url");
  const response = NextResponse.redirect(buildGoogleAuthUrl(state));
  response.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: STATE_COOKIE_PATH,
    maxAge: 10 * 60,
  });
  return response;
}
