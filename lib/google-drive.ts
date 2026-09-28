// Thin Google OAuth + Drive v3 client over plain fetch (no googleapis
// dependency). Used ONLY by the lecturer Drive backup feature
// (lib/drive-backup.ts + app/api/google-drive/*). Scope is drive.file:
// SAMS can see/modify only the folder and file it created itself in the
// lecturer's Drive — nothing else there.

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const BACKUP_FOLDER_NAME = "SAMS Backup";
export const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const FILES_URL = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
const REQUEST_TIMEOUT_MS = 30_000;

// The refresh token is invalid/revoked (or otherwise unusable) — the
// lecturer must reconnect. Distinct from any other (transient) failure.
export class DriveReconnectError extends Error {
  constructor(message = "Google Drive access was revoked or has expired.") {
    super(message);
    this.name = "DriveReconnectError";
  }
}

interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function getGoogleConfig(): GoogleConfig | null {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const redirectUri = process.env.GOOGLE_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

export function driveConfigured(): boolean {
  return getGoogleConfig() !== null;
}

function requireConfig(): GoogleConfig {
  const config = getGoogleConfig();
  if (!config) throw new Error("GOOGLE_NOT_CONFIGURED");
  return config;
}

async function googleFetch(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

async function describeError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  return `Google API ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`;
}

// access_type=offline + prompt=consent guarantees a refresh token is
// issued, even when the lecturer has consented before.
export function buildGoogleAuthUrl(state: string): string {
  const { clientId, redirectUri } = requireConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: DRIVE_SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export async function exchangeCodeForTokens(
  code: string
): Promise<{ accessToken: string; refreshToken: string | null }> {
  const { clientId, clientSecret, redirectUri } = requireConfig();
  const res = await googleFetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(await describeError(res));
  const json = (await res.json()) as { access_token: string; refresh_token?: string };
  return { accessToken: json.access_token, refreshToken: json.refresh_token ?? null };
}

// invalid_grant (revoked, expired, or password-reset-invalidated refresh
// token) means "reconnect".
export async function refreshAccessToken(refreshToken: string): Promise<string> {
  const { clientId, clientSecret } = requireConfig();
  const res = await googleFetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (body.error === "invalid_grant") {
      throw new DriveReconnectError();
    }
    // e.g. invalid_client — a server config problem, not something the
    // lecturer reconnecting would fix, so it stays a generic failure.
    throw new Error(
      `Google token refresh failed (${res.status}${body.error ? `: ${body.error}` : ""})`
    );
  }
  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}

export async function revokeToken(token: string): Promise<void> {
  await googleFetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
}

function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

async function checkAuth(res: Response): Promise<void> {
  // A 401 with a token we just refreshed means access was pulled.
  if (res.status === 401) throw new DriveReconnectError();
  if (!res.ok) throw new Error(await describeError(res));
}

export async function createBackupFolder(accessToken: string): Promise<string> {
  const res = await googleFetch(`${FILES_URL}?fields=id`, {
    method: "POST",
    headers: { ...authHeaders(accessToken), "Content-Type": "application/json" },
    body: JSON.stringify({
      name: BACKUP_FOLDER_NAME,
      mimeType: "application/vnd.google-apps.folder",
    }),
  });
  await checkAuth(res);
  return ((await res.json()) as { id: string }).id;
}

// False when the folder was deleted/trashed by the lecturer (or is no
// longer visible to this app) — the caller then creates a fresh one.
export async function isFolderUsable(
  accessToken: string,
  folderId: string
): Promise<boolean> {
  const res = await googleFetch(
    `${FILES_URL}/${encodeURIComponent(folderId)}?fields=id,trashed`,
    { headers: authHeaders(accessToken) }
  );
  if (res.status === 404 || res.status === 403) return false;
  await checkAuth(res);
  const json = (await res.json()) as { trashed?: boolean };
  return !json.trashed;
}

// Replaces the content of an existing file in place. Returns false when
// the file no longer exists (deleted by the lecturer) so the caller can
// create a new one instead.
export async function updateFileContent(
  accessToken: string,
  fileId: string,
  content: Buffer
): Promise<boolean> {
  const res = await googleFetch(
    `${UPLOAD_URL}/${encodeURIComponent(fileId)}?uploadType=media&fields=id,trashed`,
    {
      method: "PATCH",
      headers: { ...authHeaders(accessToken), "Content-Type": XLSX_MIME },
      body: new Uint8Array(content),
    }
  );
  if (res.status === 404 || res.status === 403) return false;
  await checkAuth(res);
  const json = (await res.json()) as { trashed?: boolean };
  return !json.trashed;
}

export async function createFile(
  accessToken: string,
  params: { name: string; folderId: string; content: Buffer }
): Promise<string> {
  const boundary = `sams-${Date.now().toString(36)}`;
  const metadata = JSON.stringify({
    name: params.name,
    parents: [params.folderId],
    mimeType: XLSX_MIME,
  });
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
        `--${boundary}\r\nContent-Type: ${XLSX_MIME}\r\n\r\n`
    ),
    params.content,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const res = await googleFetch(`${UPLOAD_URL}?uploadType=multipart&fields=id`, {
    method: "POST",
    headers: {
      ...authHeaders(accessToken),
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body: new Uint8Array(body),
  });
  await checkAuth(res);
  return ((await res.json()) as { id: string }).id;
}
