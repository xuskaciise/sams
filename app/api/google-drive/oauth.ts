import { NextResponse } from "next/server";

// Shared by the connect + callback route handlers (lecturer Google Drive
// backup — see lib/drive-backup.ts).

export const STATE_COOKIE = "sams_gdrive_state";
export const STATE_COOKIE_PATH = "/api/google-drive";

export type DriveConnectOutcome =
  | "connected"
  | "denied"
  | "error"
  | "unavailable"
  | "forbidden";

// Redirects back to the dashboard. The origin comes from
// GOOGLE_REDIRECT_URI (the app's real public URL) rather than request.url,
// which behind the reverse proxy may be the container's internal address.
export function redirectToDashboard(
  requestUrl: string,
  outcome: DriveConnectOutcome
): NextResponse {
  const base = process.env.GOOGLE_REDIRECT_URI?.trim() || requestUrl;
  const url = new URL("/", base);
  url.searchParams.set("drive", outcome);
  const response = NextResponse.redirect(url);
  response.cookies.delete({ name: STATE_COOKIE, path: STATE_COOKIE_PATH });
  return response;
}
