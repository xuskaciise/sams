import { cookies } from "next/headers";
import { createHash } from "crypto";
import type { User } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { PermissionKey } from "@/lib/permissions";
import {
  getCachedPermissions,
  setCachedPermissions,
} from "@/lib/permission-cache";

export const SESSION_COOKIE_NAME = "sams_session";

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function getCurrentUser(): Promise<User | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    include: { user: true },
  });
  if (!session) return null;
  if (session.expiresAt < new Date()) return null;

  const { user } = session;
  if (!user.isActive || user.deletedAt) return null;

  return user;
}

export interface UserAccess {
  permissions: Set<string>;
  roleNames: string[];
}

// Effective permissions = union of all role grants, minus explicit DENY
// overrides, plus explicit GRANT overrides. DENY always wins over any
// role grant; GRANT only ever ADDS (a permission both role-granted and
// override-granted stays granted).
export async function getUserAccess(userId: string): Promise<UserAccess> {
  const cached = getCachedPermissions(userId);
  if (cached) {
    return { permissions: cached.permissions, roleNames: cached.roleNames };
  }

  const [userRoles, overrides] = await Promise.all([
    prisma.userRole.findMany({
      where: { userId },
      include: {
        role: {
          include: { rolePermissions: { include: { permission: true } } },
        },
      },
    }),
    prisma.userPermissionOverride.findMany({
      where: { userId },
      include: { permission: true },
    }),
  ]);

  const permissions = new Set<string>();
  for (const ur of userRoles) {
    for (const rp of ur.role.rolePermissions) {
      permissions.add(rp.permission.key);
    }
  }
  for (const o of overrides) {
    if (o.effect === "GRANT") permissions.add(o.permission.key);
  }
  for (const o of overrides) {
    if (o.effect === "DENY") permissions.delete(o.permission.key);
  }

  const roleNames = userRoles.map((ur) => ur.role.name);
  setCachedPermissions(userId, permissions, roleNames);
  return { permissions, roleNames };
}

// Every Server Action must call this first — see CLAUDE.md. Replaces the
// old requireRole: authorization is a permission key, never a role name.
// Ownership checks (requireAssessmentOwner / requireAssignmentOwner) and
// status checks (DRAFT/PUBLISHED/CLOSED) still apply ON TOP of this.
export async function requirePermission(key: PermissionKey): Promise<User> {
  const user = await getCurrentUser();
  if (!user) {
    throw new Error("UNAUTHENTICATED");
  }
  const { permissions } = await getUserAccess(user.id);
  if (!permissions.has(key)) {
    throw new Error("FORBIDDEN");
  }
  return user;
}

// One call for layouts/pages that need the user plus their access —
// avoids re-deriving permissions per nav item.
export async function getSessionContext(): Promise<{
  user: User;
  permissions: Set<string>;
  roleNames: string[];
} | null> {
  const user = await getCurrentUser();
  if (!user) return null;
  const { permissions, roleNames } = await getUserAccess(user.id);
  return { user, permissions, roleNames };
}

// Only the assessment's effective owner may edit it — not co-assigned
// lecturers, not the Dean directly (Dean acts through the separate
// ownership-transfer flow). "Effective owner" is createdBy UNLESS the
// Dean has transferred this specific assessment, in which case it's the
// most recent transfer's recipient — createdBy itself never changes
// (kept as permanent history), so ownership after a transfer can only be
// determined by consulting ownership_transfers.
export async function requireAssessmentOwner(assessmentId: string) {
  const user = await getCurrentUser();
  if (!user) {
    throw new Error("UNAUTHENTICATED");
  }

  const assessment = await prisma.assessment.findUnique({
    where: { id: assessmentId },
  });
  if (!assessment || assessment.deletedAt) {
    throw new Error("NOT_FOUND");
  }

  const latestTransfer = await prisma.ownershipTransfer.findFirst({
    where: { assessmentId },
    orderBy: { createdAt: "desc" },
  });
  const effectiveOwnerId = latestTransfer?.toLecturer ?? assessment.createdBy;

  if (effectiveOwnerId !== user.id) {
    throw new Error("FORBIDDEN");
  }

  return { user, assessment };
}

// Groups are course-assignment-scoped (not assessment-scoped) — only the
// lecturer assigned to teach that course/class/semester may manage them.
export async function requireAssignmentOwner(assignmentId: string) {
  const user = await getCurrentUser();
  if (!user) {
    throw new Error("UNAUTHENTICATED");
  }

  const assignment = await prisma.lecturerCourseAssignment.findUnique({
    where: { id: assignmentId },
    include: { lecturer: true },
  });
  if (!assignment) {
    throw new Error("NOT_FOUND");
  }
  if (assignment.lecturer.userId !== user.id) {
    throw new Error("FORBIDDEN");
  }

  return { user, assignment };
}
