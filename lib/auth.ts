import { cookies } from "next/headers";
import { createHash } from "crypto";
import type { Role, User } from "@prisma/client";
import { prisma } from "@/lib/db";

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

// Every Server Action must call this first — see CLAUDE.md.
export async function requireRole(...roles: Role[]): Promise<User> {
  const user = await getCurrentUser();
  if (!user) {
    throw new Error("UNAUTHENTICATED");
  }
  if (!roles.includes(user.role)) {
    throw new Error("FORBIDDEN");
  }
  return user;
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
