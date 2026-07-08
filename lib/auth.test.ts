import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/headers", () => ({
  cookies: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    session: { findUnique: vi.fn() },
    assessment: { findUnique: vi.fn() },
    ownershipTransfer: { findFirst: vi.fn() },
  },
}));

import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { requireAssessmentOwner } from "./auth";

const creatorUser = { id: "creator-1", isActive: true, deletedAt: null, role: "LECTURER" };
const newOwnerUser = { id: "new-owner-1", isActive: true, deletedAt: null, role: "LECTURER" };
const strangerUser = { id: "stranger-1", isActive: true, deletedAt: null, role: "LECTURER" };

function mockSession(user: typeof creatorUser) {
  vi.mocked(cookies).mockResolvedValue({
    get: () => ({ value: "token" }),
  } as never);
  vi.mocked(prisma.session.findUnique).mockResolvedValue({
    id: "sess-1",
    expiresAt: new Date(Date.now() + 100000),
    user,
  } as never);
}

// This is the crux of Dean ownership transfer: created_by is kept as
// permanent history and never changes, so "who can currently edit" has to
// be resolved via the most recent ownership_transfers row instead —
// exactly the "non-owner-cannot-edit" rule CLAUDE.md calls out as a top
// test priority, now with a transfer in the mix.
describe("requireAssessmentOwner", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(prisma.assessment.findUnique).mockResolvedValue({
      id: "assessment-1",
      createdBy: creatorUser.id,
      deletedAt: null,
    } as never);
  });

  it("allows the original creator when there has been no transfer", async () => {
    mockSession(creatorUser);
    vi.mocked(prisma.ownershipTransfer.findFirst).mockResolvedValue(null);

    const result = await requireAssessmentOwner("assessment-1");
    expect(result.user.id).toBe(creatorUser.id);
  });

  it("blocks the original creator once ownership has been transferred away", async () => {
    mockSession(creatorUser);
    vi.mocked(prisma.ownershipTransfer.findFirst).mockResolvedValue({
      toLecturer: newOwnerUser.id,
    } as never);

    await expect(requireAssessmentOwner("assessment-1")).rejects.toThrow("FORBIDDEN");
  });

  it("allows the new owner to edit after a transfer", async () => {
    mockSession(newOwnerUser);
    vi.mocked(prisma.ownershipTransfer.findFirst).mockResolvedValue({
      toLecturer: newOwnerUser.id,
    } as never);

    const result = await requireAssessmentOwner("assessment-1");
    expect(result.user.id).toBe(newOwnerUser.id);
  });

  it("blocks an unrelated lecturer regardless of any transfer", async () => {
    mockSession(strangerUser);
    vi.mocked(prisma.ownershipTransfer.findFirst).mockResolvedValue({
      toLecturer: newOwnerUser.id,
    } as never);

    await expect(requireAssessmentOwner("assessment-1")).rejects.toThrow("FORBIDDEN");
  });

  it("looks up the most recent transfer (ordered by createdAt desc)", async () => {
    mockSession(newOwnerUser);
    vi.mocked(prisma.ownershipTransfer.findFirst).mockResolvedValue({
      toLecturer: newOwnerUser.id,
    } as never);

    await requireAssessmentOwner("assessment-1");

    expect(prisma.ownershipTransfer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { assessmentId: "assessment-1" },
        orderBy: { createdAt: "desc" },
      })
    );
  });

  it("throws NOT_FOUND for a soft-deleted assessment", async () => {
    mockSession(creatorUser);
    vi.mocked(prisma.assessment.findUnique).mockResolvedValue({
      id: "assessment-1",
      createdBy: creatorUser.id,
      deletedAt: new Date(),
    } as never);

    await expect(requireAssessmentOwner("assessment-1")).rejects.toThrow("NOT_FOUND");
  });

  it("throws UNAUTHENTICATED when there is no session", async () => {
    vi.mocked(cookies).mockResolvedValue({ get: () => undefined } as never);

    await expect(requireAssessmentOwner("assessment-1")).rejects.toThrow(
      "UNAUTHENTICATED"
    );
  });
});
