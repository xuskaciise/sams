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

// Only the assessment's creator may edit it — not co-assigned lecturers,
// not the Dean (Dean acts through the separate ownership-transfer flow).
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
  if (assessment.createdBy !== user.id) {
    throw new Error("FORBIDDEN");
  }

  return { user, assessment };
}
