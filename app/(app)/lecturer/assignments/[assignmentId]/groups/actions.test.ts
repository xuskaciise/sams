import { describe, it, expect, vi, beforeEach } from "vitest";

const mockUser = { id: "lecturer-user-1" };
const mockAssignment = { id: "assignment-1" };

vi.mock("@/lib/auth", () => ({
  requireAssignmentOwner: vi.fn(),
}));

const { MockPrismaClientKnownRequestError } = vi.hoisted(() => {
  class MockPrismaClientKnownRequestError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  }
  return { MockPrismaClientKnownRequestError };
});

vi.mock("@prisma/client", () => ({
  Prisma: {
    PrismaClientKnownRequestError: MockPrismaClientKnownRequestError,
  },
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    studentGroup: {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    groupMember: {
      create: vi.fn(),
      delete: vi.fn(),
    },
    assessmentResult: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { requireAssignmentOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  createGroup,
  renameGroup,
  deleteGroup,
  addGroupMember,
  removeGroupMember,
} from "./actions";

describe("groups actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAssignmentOwner).mockResolvedValue({
      user: mockUser,
      assignment: mockAssignment,
    } as never);
  });

  describe("deleteGroup", () => {
    it("blocks deletion when the group has a published result — snapshot model integrity", async () => {
      vi.mocked(prisma.assessmentResult.findFirst).mockResolvedValue({
        id: "result-1",
      } as never);

      await expect(deleteGroup("assignment-1", "group-1")).rejects.toThrow(
        "HAS_PUBLISHED_RESULTS"
      );
      expect(prisma.assessmentResult.findFirst).toHaveBeenCalledWith({
        where: { groupId: "group-1", status: "PUBLISHED" },
      });
      expect(prisma.studentGroup.delete).not.toHaveBeenCalled();
    });

    it("deletes the group when no published result references it", async () => {
      vi.mocked(prisma.assessmentResult.findFirst).mockResolvedValue(null);

      await deleteGroup("assignment-1", "group-1");

      expect(prisma.studentGroup.delete).toHaveBeenCalledWith({
        where: { id: "group-1" },
      });
    });

    it("enforces assignment ownership before touching the group", async () => {
      vi.mocked(requireAssignmentOwner).mockRejectedValue(
        new Error("FORBIDDEN")
      );

      await expect(deleteGroup("assignment-1", "group-1")).rejects.toThrow(
        "FORBIDDEN"
      );
      expect(prisma.assessmentResult.findFirst).not.toHaveBeenCalled();
      expect(prisma.studentGroup.delete).not.toHaveBeenCalled();
    });
  });

  describe("removeGroupMember", () => {
    it("never checks for published results — removing a member cannot affect saved marks", async () => {
      await removeGroupMember("assignment-1", "member-1");

      expect(prisma.assessmentResult.findFirst).not.toHaveBeenCalled();
      expect(prisma.groupMember.delete).toHaveBeenCalledWith({
        where: { id: "member-1" },
      });
    });
  });

  describe("addGroupMember", () => {
    it("translates a unique-constraint violation into ALREADY_IN_GROUP", async () => {
      vi.mocked(prisma.groupMember.create).mockRejectedValue(
        new MockPrismaClientKnownRequestError("duplicate", "P2002")
      );

      await expect(
        addGroupMember("assignment-1", "group-1", "student-1")
      ).rejects.toThrow("ALREADY_IN_GROUP");
    });

    it("re-throws unrelated errors", async () => {
      vi.mocked(prisma.groupMember.create).mockRejectedValue(
        new Error("connection lost")
      );

      await expect(
        addGroupMember("assignment-1", "group-1", "student-1")
      ).rejects.toThrow("connection lost");
    });
  });

  describe("createGroup / renameGroup", () => {
    it("rejects a blank group name", async () => {
      await expect(
        createGroup("assignment-1", { name: "   " })
      ).rejects.toThrow();
      expect(prisma.studentGroup.create).not.toHaveBeenCalled();
    });

    it("trims the name before saving", async () => {
      await createGroup("assignment-1", { name: "  Group C  " });

      expect(prisma.studentGroup.create).toHaveBeenCalledWith({
        data: { assignmentId: "assignment-1", name: "Group C" },
      });
    });

    it("renames a group", async () => {
      await renameGroup("assignment-1", "group-1", { name: "New Name" });

      expect(prisma.studentGroup.update).toHaveBeenCalledWith({
        where: { id: "group-1" },
        data: { name: "New Name" },
      });
    });
  });
});
