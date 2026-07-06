import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    session: {
      findUnique: vi.fn(),
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
      expiresAt: new Date(Date.now() + 60_000),
      user: { isActive: true, deletedAt: null, mustChangePw: true },
    } as never);

    const response = await proxy(makeRequest("/", "valid-token"));
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/change-password"
    );
  });

  it("allows /change-password through when mustChangePw is true", async () => {
    vi.mocked(prisma.session.findUnique).mockResolvedValue({
      expiresAt: new Date(Date.now() + 60_000),
      user: { isActive: true, deletedAt: null, mustChangePw: true },
    } as never);

    const response = await proxy(makeRequest("/change-password", "valid-token"));
    expect(response.headers.get("location")).toBeNull();
  });

  it("redirects away from /change-password once mustChangePw is false", async () => {
    vi.mocked(prisma.session.findUnique).mockResolvedValue({
      expiresAt: new Date(Date.now() + 60_000),
      user: { isActive: true, deletedAt: null, mustChangePw: false },
    } as never);

    const response = await proxy(makeRequest("/change-password", "valid-token"));
    expect(response.headers.get("location")).toBe("http://localhost:3000/");
  });

  it("treats an expired session as unauthenticated", async () => {
    vi.mocked(prisma.session.findUnique).mockResolvedValue({
      expiresAt: new Date(Date.now() - 60_000),
      user: { isActive: true, deletedAt: null, mustChangePw: false },
    } as never);

    const response = await proxy(makeRequest("/", "expired-token"));
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/login"
    );
  });

  it("treats a deactivated user's session as unauthenticated", async () => {
    vi.mocked(prisma.session.findUnique).mockResolvedValue({
      expiresAt: new Date(Date.now() + 60_000),
      user: { isActive: false, deletedAt: null, mustChangePw: false },
    } as never);

    const response = await proxy(makeRequest("/", "deactivated-token"));
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/login"
    );
  });

  it("allows a normal authenticated request through unmodified", async () => {
    vi.mocked(prisma.session.findUnique).mockResolvedValue({
      expiresAt: new Date(Date.now() + 60_000),
      user: { isActive: true, deletedAt: null, mustChangePw: false },
    } as never);

    const response = await proxy(makeRequest("/admin/users", "valid-token"));
    expect(response.headers.get("location")).toBeNull();
  });
});
