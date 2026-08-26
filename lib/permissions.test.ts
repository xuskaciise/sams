import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/headers", () => ({
  cookies: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    session: { findUnique: vi.fn() },
    userRole: { findMany: vi.fn() },
    userPermissionOverride: { findMany: vi.fn() },
  },
}));

import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { getUserAccess, requirePermission } from "./auth";
import { invalidateAllPermissions } from "./permission-cache";
import {
  PERMISSIONS,
  PERMISSION_KEYS,
  DEFAULT_ROLE_GRANTS,
  SYSTEM_ROLES,
} from "./permissions";

function mockSession(userId: string) {
  vi.mocked(cookies).mockResolvedValue({
    get: () => ({ value: "token" }),
  } as never);
  vi.mocked(prisma.session.findUnique).mockResolvedValue({
    id: "sess-1",
    expiresAt: new Date(Date.now() + 100000),
    lastActivityAt: new Date(),
    user: { id: userId, isActive: true, deletedAt: null },
  } as never);
}

function mockRoles(roles: { name: string; keys: string[] }[]) {
  vi.mocked(prisma.userRole.findMany).mockResolvedValue(
    roles.map((r, i) => ({
      role: {
        name: r.name,
        rolePermissions: r.keys.map((key) => ({ permission: { key } })),
      },
      id: `ur-${i}`,
    })) as never
  );
}

function mockOverrides(
  overrides: { key: string; effect: "GRANT" | "DENY" }[]
) {
  vi.mocked(prisma.userPermissionOverride.findMany).mockResolvedValue(
    overrides.map((o, i) => ({
      id: `ov-${i}`,
      effect: o.effect,
      permission: { key: o.key },
    })) as never
  );
}

describe("effective permission math (getUserAccess)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // The cache is real module state — flush it so tests never see each
    // other's results.
    invalidateAllPermissions();
  });

  it("a multi-role user gets the UNION of every role's grants", async () => {
    mockRoles([
      { name: "LECTURER", keys: ["assessment.create", "results.enter"] },
      { name: "DEAN", keys: ["results.enter", "semester.close"] },
    ]);
    mockOverrides([]);

    const { permissions } = await getUserAccess("multi-role-user");
    expect(Array.from(permissions).sort()).toEqual([
      "assessment.create",
      "results.enter",
      "semester.close",
    ]);
  });

  it("an explicit DENY override beats a role grant", async () => {
    mockRoles([
      { name: "LECTURER", keys: ["assessment.create", "assessment.publish"] },
    ]);
    mockOverrides([{ key: "assessment.publish", effect: "DENY" }]);

    const { permissions } = await getUserAccess("denied-user");
    expect(permissions.has("assessment.create")).toBe(true);
    expect(permissions.has("assessment.publish")).toBe(false);
  });

  it("an explicit GRANT override adds on top of role grants", async () => {
    mockRoles([{ name: "STUDENT", keys: ["results.view.own"] }]);
    mockOverrides([{ key: "audit.view", effect: "GRANT" }]);

    const { permissions } = await getUserAccess("granted-user");
    expect(permissions.has("results.view.own")).toBe(true);
    expect(permissions.has("audit.view")).toBe(true);
  });

  it("DENY wins even when the same permission is also GRANT-overridden by a role", async () => {
    mockRoles([{ name: "Custom", keys: ["user.manage"] }]);
    mockOverrides([{ key: "user.manage", effect: "DENY" }]);

    const { permissions } = await getUserAccess("deny-wins-user");
    expect(permissions.has("user.manage")).toBe(false);
  });
});

describe("requirePermission", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    invalidateAllPermissions();
  });

  it("a custom role with only view permissions cannot mutate", async () => {
    mockSession("viewer-1");
    mockRoles([
      { name: "Viewer", keys: ["reports.view.all", "audit.view"] },
    ]);
    mockOverrides([]);

    await expect(requirePermission("assessment.create")).rejects.toThrow(
      "FORBIDDEN"
    );
  });

  it("allows a permission the user's role grants", async () => {
    mockSession("viewer-2");
    mockRoles([{ name: "Viewer", keys: ["reports.view.all"] }]);
    mockOverrides([]);

    const user = await requirePermission("reports.view.all");
    expect(user.id).toBe("viewer-2");
  });

  it("rejects unauthenticated calls", async () => {
    vi.mocked(cookies).mockResolvedValue({ get: () => undefined } as never);
    await expect(requirePermission("user.manage")).rejects.toThrow(
      "UNAUTHENTICATED"
    );
  });
});

// The seed mapping IS the security model now — these pin the critical
// CLAUDE.md rules in permission terms so a seed edit can't silently
// relax them.
describe("system role seed grants (DEFAULT_ROLE_GRANTS parity)", () => {
  it("every granted key exists in the permission catalog", () => {
    for (const role of SYSTEM_ROLES) {
      for (const key of DEFAULT_ROLE_GRANTS[role]) {
        expect(PERMISSION_KEYS).toContain(key);
      }
    }
  });

  it("ADMIN holds ZERO assessment/results/groups permissions — admin can never touch academic data", () => {
    const forbiddenPrefixes = ["assessment.", "results.", "groups."];
    for (const key of DEFAULT_ROLE_GRANTS.ADMIN) {
      for (const prefix of forbiddenPrefixes) {
        expect(key.startsWith(prefix)).toBe(false);
      }
    }
  });

  it("STUDENT holds exactly results.view.own + dailylog.view.own + timetable.view.own — never the full daily log, never write", () => {
    expect([...DEFAULT_ROLE_GRANTS.STUDENT].sort()).toEqual([
      "dailylog.view.own",
      "results.view.own",
      "timetable.view.own",
    ]);
    expect(DEFAULT_ROLE_GRANTS.STUDENT).not.toContain("dailylog.view");
    expect(DEFAULT_ROLE_GRANTS.STUDENT).not.toContain("dailylog.create");
    expect(DEFAULT_ROLE_GRANTS.STUDENT).not.toContain("timetable.manage");
  });

  it("LECTURER holds no admin, dean, or cross-course permissions", () => {
    const lecturer = new Set<string>(DEFAULT_ROLE_GRANTS.LECTURER);
    for (const key of [
      "user.manage",
      "user.delete",
      "roles.manage",
      "structure.manage",
      "students.manage",
      "enrollments.manage",
      "reports.view.all",
      "semester.close",
      "semester.open",
      "ownership.transfer",
    ]) {
      expect(lecturer.has(key)).toBe(false);
    }
  });

  it("DEAN holds exactly transfer/reports-all/dailylog/timetable/workload-auto-timetable — no entry, edit, publish, or close", () => {
    expect([...DEFAULT_ROLE_GRANTS.DEAN].sort()).toEqual([
      "dailylog.create",
      "dailylog.view",
      "ownership.transfer",
      "reports.view.all",
      "timetable.generate",
      "timetable.manage",
      "timetable.view",
      "workload.import",
    ]);
  });

  it("ADMIN holds semester.close — closing the calendar is a global admin action, not a Dean tool", () => {
    expect(DEFAULT_ROLE_GRANTS.ADMIN).toContain("semester.close");
  });

  it("ADMIN and DEAN both hold dailylog.create/dailylog.view — LECTURER/STUDENT hold neither", () => {
    expect(DEFAULT_ROLE_GRANTS.ADMIN).toEqual(
      expect.arrayContaining(["dailylog.create", "dailylog.view"])
    );
    expect(DEFAULT_ROLE_GRANTS.DEAN).toEqual(
      expect.arrayContaining(["dailylog.create", "dailylog.view"])
    );
    expect(DEFAULT_ROLE_GRANTS.LECTURER).not.toContain("dailylog.create");
    expect(DEFAULT_ROLE_GRANTS.LECTURER).not.toContain("dailylog.view");
    expect(DEFAULT_ROLE_GRANTS.STUDENT).not.toContain("dailylog.create");
    expect(DEFAULT_ROLE_GRANTS.STUDENT).not.toContain("dailylog.view");
  });

  it("LECTURER holds exactly dailylog.view.own (read own leave notices, never the faculty log, never write)", () => {
    expect(DEFAULT_ROLE_GRANTS.LECTURER).toContain("dailylog.view.own");
    expect(DEFAULT_ROLE_GRANTS.LECTURER).not.toContain("dailylog.view");
    expect(DEFAULT_ROLE_GRANTS.LECTURER).not.toContain("dailylog.create");
  });

  it("ADMIN and DEAN both hold timetable.manage/timetable.view — LECTURER/STUDENT hold only the narrower view.own", () => {
    expect(DEFAULT_ROLE_GRANTS.ADMIN).toEqual(
      expect.arrayContaining(["timetable.manage", "timetable.view"])
    );
    expect(DEFAULT_ROLE_GRANTS.DEAN).toEqual(
      expect.arrayContaining(["timetable.manage", "timetable.view"])
    );
    expect(DEFAULT_ROLE_GRANTS.LECTURER).toContain("timetable.view.own");
    expect(DEFAULT_ROLE_GRANTS.LECTURER).not.toContain("timetable.manage");
    expect(DEFAULT_ROLE_GRANTS.STUDENT).toContain("timetable.view.own");
    expect(DEFAULT_ROLE_GRANTS.STUDENT).not.toContain("timetable.manage");
  });

  it("campus.manage/room.manage/shift.manage are ADMIN-only — DEAN keeps scoped timetable.manage but not the infrastructure keys", () => {
    for (const key of ["campus.manage", "room.manage", "shift.manage"] as const) {
      expect(DEFAULT_ROLE_GRANTS.ADMIN).toContain(key);
      expect(DEFAULT_ROLE_GRANTS.DEAN).not.toContain(key);
      expect(DEFAULT_ROLE_GRANTS.LECTURER).not.toContain(key);
      expect(DEFAULT_ROLE_GRANTS.STUDENT).not.toContain(key);
    }
  });

  it("whatsapp.manage is ADMIN-only — best-effort/unofficial WhatsApp notifications are centrally administered, same split as campus/room/shift", () => {
    expect(DEFAULT_ROLE_GRANTS.ADMIN).toContain("whatsapp.manage");
    expect(DEFAULT_ROLE_GRANTS.DEAN).not.toContain("whatsapp.manage");
    expect(DEFAULT_ROLE_GRANTS.LECTURER).not.toContain("whatsapp.manage");
    expect(DEFAULT_ROLE_GRANTS.STUDENT).not.toContain("whatsapp.manage");
  });

  it("notification.templates.manage is ADMIN-only — message wording is a separate, centrally administered concern from whatsapp.manage's on/off switch", () => {
    expect(DEFAULT_ROLE_GRANTS.ADMIN).toContain("notification.templates.manage");
    expect(DEFAULT_ROLE_GRANTS.DEAN).not.toContain("notification.templates.manage");
    expect(DEFAULT_ROLE_GRANTS.LECTURER).not.toContain("notification.templates.manage");
    expect(DEFAULT_ROLE_GRANTS.STUDENT).not.toContain("notification.templates.manage");
  });

  it("permission catalog has no duplicate keys", () => {
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSIONS.length);
  });
});
