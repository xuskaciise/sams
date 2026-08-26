import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    session: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import { prisma } from "@/lib/db";
import { proxy } from "./proxy";

function makeRequest(path: string, token?: string) {
  const headers = new Headers();
  if (token) headers.set("cookie", `sams_session=${token}`);
  return new NextRequest(`http://localhost:3000${path}`, { headers });
}

describe("proxy (session + forced password change gate)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redirects to /login when there is no session cookie", async () => {
    const response = await proxy(makeRequest("/"));
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/login"
    );
  });

  it("allows /login through when there is no session", async () => {
    const response = await proxy(makeRequest("/login"));
    expect(response.headers.get("location")).toBeNull();
  });

  it("redirects to /change-password when mustChangePw is true and visiting another page", async () => {
    vi.mocked(prisma.session.findUnique).mockResolvedValue({
      id: "sess-1",
      expiresAt: new Date(Date.now() + 60_000),
      lastActivityAt: new Date(),
      user: { isActive: true, deletedAt: null, mustChangePw: true },
    } as never);

    const response = await proxy(makeRequest("/", "valid-token"));
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/change-password"
    );
  });

  it("allows /change-password through when mustChangePw is true", async () => {
    vi.mocked(prisma.session.findUnique).mockResolvedValue({
      id: "sess-1",
      expiresAt: new Date(Date.now() + 60_000),
      lastActivityAt: new Date(),
      user: { isActive: true, deletedAt: null, mustChangePw: true },
    } as never);

    const response = await proxy(makeRequest("/change-password", "valid-token"));
    expect(response.headers.get("location")).toBeNull();
  });

  it("redirects away from /change-password once mustChangePw is false", async () => {
    vi.mocked(prisma.session.findUnique).mockResolvedValue({
      id: "sess-1",
      expiresAt: new Date(Date.now() + 60_000),
      lastActivityAt: new Date(),
      user: { isActive: true, deletedAt: null, mustChangePw: false },
    } as never);

    const response = await proxy(makeRequest("/change-password", "valid-token"));
    expect(response.headers.get("location")).toBe("http://localhost:3000/");
  });

  it("treats an expired session as unauthenticated", async () => {
    vi.mocked(prisma.session.findUnique).mockResolvedValue({
      id: "sess-1",
      expiresAt: new Date(Date.now() - 60_000),
      lastActivityAt: new Date(),
      user: { isActive: true, deletedAt: null, mustChangePw: false },
    } as never);

    const response = await proxy(makeRequest("/", "expired-token"));
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/login"
    );
  });

  it("treats a deactivated user's session as unauthenticated", async () => {
    vi.mocked(prisma.session.findUnique).mockResolvedValue({
      id: "sess-1",
      expiresAt: new Date(Date.now() + 60_000),
      lastActivityAt: new Date(),
      user: { isActive: false, deletedAt: null, mustChangePw: false },
    } as never);

    const response = await proxy(makeRequest("/", "deactivated-token"));
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/login"
    );
  });

  it("allows a normal authenticated request through unmodified", async () => {
    vi.mocked(prisma.session.findUnique).mockResolvedValue({
      id: "sess-1",
      expiresAt: new Date(Date.now() + 60_000),
      lastActivityAt: new Date(),
      user: { isActive: true, deletedAt: null, mustChangePw: false },
    } as never);

    const response = await proxy(makeRequest("/admin/users", "valid-token"));
    expect(response.headers.get("location")).toBeNull();
  });

  it("bumps lastActivityAt on every valid authenticated request", async () => {
    vi.mocked(prisma.session.findUnique).mockResolvedValue({
      id: "sess-1",
      expiresAt: new Date(Date.now() + 60_000),
      lastActivityAt: new Date(Date.now() - 60_000),
      user: { isActive: true, deletedAt: null, mustChangePw: false },
    } as never);

    await proxy(makeRequest("/admin/users", "valid-token"));

    expect(prisma.session.update).toHaveBeenCalledWith({
      where: { id: "sess-1" },
      data: { lastActivityAt: expect.any(Date) },
    });
  });

  it("treats a session idle for more than 30 minutes as expired and redirects with reason=idle_timeout", async () => {
    vi.mocked(prisma.session.findUnique).mockResolvedValue({
      id: "sess-1",
      expiresAt: new Date(Date.now() + 60_000),
      lastActivityAt: new Date(Date.now() - 31 * 60 * 1000),
      user: { isActive: true, deletedAt: null, mustChangePw: false },
    } as never);

    const response = await proxy(makeRequest("/admin/users", "idle-token"));
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/login?reason=idle_timeout"
    );
    expect(prisma.session.update).not.toHaveBeenCalled();
  });

  it("does not idle-timeout a session active within the last 30 minutes", async () => {
    vi.mocked(prisma.session.findUnique).mockResolvedValue({
      id: "sess-1",
      expiresAt: new Date(Date.now() + 60_000),
      lastActivityAt: new Date(Date.now() - 29 * 60 * 1000),
      user: { isActive: true, deletedAt: null, mustChangePw: false },
    } as never);

    const response = await proxy(makeRequest("/admin/users", "fresh-token"));
    expect(response.headers.get("location")).toBeNull();
  });

  it("clears the stale cookie when an idle-timed-out session lands directly on /login", async () => {
    vi.mocked(prisma.session.findUnique).mockResolvedValue({
      id: "sess-1",
      expiresAt: new Date(Date.now() + 60_000),
      lastActivityAt: new Date(Date.now() - 31 * 60 * 1000),
      user: { isActive: true, deletedAt: null, mustChangePw: false },
    } as never);

    const response = await proxy(makeRequest("/login", "idle-token"));
    expect(response.headers.get("location")).toBeNull();
    expect(response.cookies.get("sams_session")?.value).toBe("");
  });
});
