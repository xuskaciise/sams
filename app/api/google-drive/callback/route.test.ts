import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ requirePermission: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: {
    lecturer: { findUnique: vi.fn() },
    lecturerGoogleDriveConnection: { findUnique: vi.fn(), upsert: vi.fn() },
  },
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/credential-crypto", () => ({
  encryptCredential: vi.fn((v: string) => `enc:${v}`),
}));
vi.mock("@/lib/google-drive", () => ({
  exchangeCodeForTokens: vi.fn(),
  createBackupFolder: vi.fn(),
}));

import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { createBackupFolder, exchangeCodeForTokens } from "@/lib/google-drive";
import { GET } from "./route";

function request(query: string, stateCookie?: string) {
  const headers = new Headers();
  if (stateCookie) headers.set("cookie", `sams_gdrive_state=${stateCookie}`);
  return new NextRequest(`https://sams.test/api/google-drive/callback?${query}`, { headers });
}

describe("GET /api/google-drive/callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GOOGLE_REDIRECT_URI", "https://sams.test/api/google-drive/callback");
    vi.mocked(requirePermission).mockResolvedValue({ id: "user-1" } as never);
    vi.mocked(prisma.lecturer.findUnique).mockResolvedValue({ id: "lec-1" } as never);
    vi.mocked(prisma.lecturerGoogleDriveConnection.findUnique).mockResolvedValue(null);
    vi.mocked(exchangeCodeForTokens).mockResolvedValue({ accessToken: "at", refreshToken: "rt" });
    vi.mocked(createBackupFolder).mockResolvedValue("folder-1");
  });

  it("rejects a state mismatch without touching Google or the DB", async () => {
    const res = await GET(request("code=abc&state=evil", "good"));
    expect(res.headers.get("location")).toBe("https://sams.test/?drive=error");
    expect(exchangeCodeForTokens).not.toHaveBeenCalled();
    expect(prisma.lecturerGoogleDriveConnection.upsert).not.toHaveBeenCalled();
  });

  it("requires drive.backup", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));
    const res = await GET(request("code=abc&state=s1", "s1"));
    expect(res.headers.get("location")).toBe("https://sams.test/?drive=forbidden");
    expect(requirePermission).toHaveBeenCalledWith("drive.backup");
  });

  it("stores encrypted tokens + the new folder against the SESSION's lecturer and audits", async () => {
    const res = await GET(request("code=abc&state=s1", "s1"));
    expect(res.headers.get("location")).toBe("https://sams.test/?drive=connected");
    expect(prisma.lecturer.findUnique).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      select: { id: true },
    });
    const args = vi.mocked(prisma.lecturerGoogleDriveConnection.upsert).mock.calls[0][0];
    expect(args.where).toEqual({ lecturerId: "lec-1" });
    expect(args.create).toMatchObject({
      lecturerId: "lec-1",
      accessTokenEncrypted: "enc:at",
      refreshTokenEncrypted: "enc:rt",
      driveFolderId: "folder-1",
      needsReconnect: false,
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "GOOGLE_DRIVE_CONNECTED", entityId: "lec-1" })
    );
  });

  it("errors out (stores nothing) when Google returns no refresh token", async () => {
    vi.mocked(exchangeCodeForTokens).mockResolvedValue({ accessToken: "at", refreshToken: null });
    const res = await GET(request("code=abc&state=s1", "s1"));
    expect(res.headers.get("location")).toBe("https://sams.test/?drive=error");
    expect(prisma.lecturerGoogleDriveConnection.upsert).not.toHaveBeenCalled();
  });

  it("reports a denied consent", async () => {
    const res = await GET(request("error=access_denied&state=s1", "s1"));
    expect(res.headers.get("location")).toBe("https://sams.test/?drive=denied");
  });
});
