import { describe, it, expect, vi, beforeEach } from "vitest";

const mockUser = { id: "user-1" };

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
  requireAssessmentOwner: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    assessment: { update: vi.fn() },
    assessmentResult: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    lecturerCourseAssignment: { findUniqueOrThrow: vi.fn() },
    studentCourseEnrollment: { findUnique: vi.fn() },
    resultCorrection: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/whatsapp-notify", () => ({
  notifyResultsPublished: vi.fn(),
}));

vi.mock("@/lib/email-notify", () => ({
  emailResultsPublished: vi.fn(),
}));

import { requirePermission, requireAssessmentOwner } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { notifyResultsPublished } from "@/lib/whatsapp-notify";
import {
  publishAssessment,
  saveResult,
  addLateResult,
  publishLateResult,
} from "./actions";

describe("publishAssessment", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    vi.mocked(requireAssessmentOwner).mockResolvedValue({
      user: mockUser,
      assessment: { id: "assessment-1", status: "DRAFT" },
    } as never);
    vi.mocked(prisma.$transaction).mockResolvedValue([{}, {}] as never);
  });

  it("enforces assessment.publish and ownership before touching anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(publishAssessment("assessment-1")).rejects.toThrow("FORBIDDEN");
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(notifyResultsPublished).not.toHaveBeenCalled();
  });

  it("rejects publishing an assessment that isn't DRAFT", async () => {
    vi.mocked(requireAssessmentOwner).mockResolvedValue({
      user: mockUser,
      assessment: { id: "assessment-1", status: "PUBLISHED" },
    } as never);

    await expect(publishAssessment("assessment-1")).rejects.toThrow("NOT_DRAFT");
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(notifyResultsPublished).not.toHaveBeenCalled();
  });

  it("publishes, audits RESULTS_PUBLISHED, and triggers the best-effort WhatsApp notification", async () => {
    await publishAssessment("assessment-1");

    expect(prisma.$transaction).toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        action: "RESULTS_PUBLISHED",
        entity: "Assessment",
        entityId: "assessment-1",
      })
    );
    expect(notifyResultsPublished).toHaveBeenCalledWith("assessment-1");
  });
});

describe("saveResult — status guards", () => {
  const publishedAssessment = {
    id: "assessment-1",
    status: "PUBLISHED",
    maximumMarks: 100,
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
  });

  it("rejects any edit once the assessment is CLOSED", async () => {
    vi.mocked(requireAssessmentOwner).mockResolvedValue({
      user: mockUser,
      assessment: { ...publishedAssessment, status: "CLOSED" },
    } as never);
    vi.mocked(prisma.assessmentResult.findUnique).mockResolvedValue(null);

    await expect(
      saveResult("assessment-1", {
        enrollmentId: "enr-1",
        mark: 10,
        attendanceStatus: "PRESENT",
        currentUpdatedAt: null,
      })
    ).rejects.toThrow("NOT_EDITABLE");
    expect(prisma.assessmentResult.create).not.toHaveBeenCalled();
  });

  it("rejects editing a student who has no result row yet on a PUBLISHED assessment — that's addLateResult's job", async () => {
    vi.mocked(requireAssessmentOwner).mockResolvedValue({
      user: mockUser,
      assessment: publishedAssessment,
    } as never);
    vi.mocked(prisma.assessmentResult.findUnique).mockResolvedValue(null);

    await expect(
      saveResult("assessment-1", {
        enrollmentId: "enr-1",
        mark: 10,
        attendanceStatus: "PRESENT",
        currentUpdatedAt: null,
      })
    ).rejects.toThrow("NOT_EDITABLE");
    expect(prisma.assessmentResult.create).not.toHaveBeenCalled();
  });

  it("rejects re-editing an already-published result — that's correctResult's job", async () => {
    vi.mocked(requireAssessmentOwner).mockResolvedValue({
      user: mockUser,
      assessment: publishedAssessment,
    } as never);
    vi.mocked(prisma.assessmentResult.findUnique).mockResolvedValue({
      id: "result-1",
      status: "PUBLISHED",
      updatedAt: new Date("2026-01-01"),
    } as never);

    await expect(
      saveResult("assessment-1", {
        enrollmentId: "enr-1",
        mark: 10,
        attendanceStatus: "PRESENT",
        currentUpdatedAt: "2026-01-01T00:00:00.000Z",
      })
    ).rejects.toThrow("NOT_EDITABLE");
    expect(prisma.assessmentResult.updateMany).not.toHaveBeenCalled();
  });

  it("still allows editing a late-added DRAFT result while the assessment is PUBLISHED", async () => {
    const updatedAt = new Date("2026-01-01T00:00:00.000Z");
    vi.mocked(requireAssessmentOwner).mockResolvedValue({
      user: mockUser,
      assessment: publishedAssessment,
    } as never);
    vi.mocked(prisma.assessmentResult.findUnique).mockResolvedValue({
      id: "result-1",
      status: "DRAFT",
      updatedAt,
    } as never);
    vi.mocked(prisma.assessmentResult.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.assessmentResult.findUniqueOrThrow).mockResolvedValue({
      id: "result-1",
      updatedAt,
    } as never);

    await saveResult("assessment-1", {
      enrollmentId: "enr-1",
      mark: 42,
      attendanceStatus: "PRESENT",
      currentUpdatedAt: updatedAt.toISOString(),
    });

    expect(prisma.assessmentResult.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "result-1", updatedAt },
        data: expect.objectContaining({ mark: 42 }),
      })
    );
  });
});

describe("addLateResult", () => {
  const publishedAssessment = {
    id: "assessment-1",
    assignmentId: "assignment-1",
    status: "PUBLISHED",
    maximumMarks: 100,
  };
  const assignment = {
    id: "assignment-1",
    courseId: "course-1",
    classId: "class-1",
    semesterId: "semester-1",
  };
  const activeEnrollment = {
    id: "enr-1",
    studentId: "student-1",
    courseId: "course-1",
    classId: "class-1",
    semesterId: "semester-1",
    status: "ACTIVE",
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    vi.mocked(requireAssessmentOwner).mockResolvedValue({
      user: mockUser,
      assessment: publishedAssessment,
    } as never);
    vi.mocked(prisma.lecturerCourseAssignment.findUniqueOrThrow).mockResolvedValue(
      assignment as never
    );
    vi.mocked(prisma.studentCourseEnrollment.findUnique).mockResolvedValue(
      activeEnrollment as never
    );
    vi.mocked(prisma.assessmentResult.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.assessmentResult.create).mockResolvedValue({
      id: "result-new",
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    } as never);
  });

  it("enforces results.enter and ownership before touching anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(
      addLateResult("assessment-1", {
        enrollmentId: "enr-1",
        mark: 10,
        attendanceStatus: "PRESENT",
      })
    ).rejects.toThrow("FORBIDDEN");
    expect(prisma.assessmentResult.create).not.toHaveBeenCalled();
  });

  it("rejects when the assessment isn't PUBLISHED yet", async () => {
    vi.mocked(requireAssessmentOwner).mockResolvedValue({
      user: mockUser,
      assessment: { ...publishedAssessment, status: "DRAFT" },
    } as never);

    await expect(
      addLateResult("assessment-1", {
        enrollmentId: "enr-1",
        mark: 10,
        attendanceStatus: "PRESENT",
      })
    ).rejects.toThrow("NOT_PUBLISHED");
    expect(prisma.assessmentResult.create).not.toHaveBeenCalled();
  });

  it("rejects a mark out of range", async () => {
    await expect(
      addLateResult("assessment-1", {
        enrollmentId: "enr-1",
        mark: 500,
        attendanceStatus: "PRESENT",
      })
    ).rejects.toThrow("MARK_OUT_OF_RANGE");
    expect(prisma.assessmentResult.create).not.toHaveBeenCalled();
  });

  it("rejects an enrollment that doesn't belong to this course/class/semester", async () => {
    vi.mocked(prisma.studentCourseEnrollment.findUnique).mockResolvedValue({
      ...activeEnrollment,
      courseId: "some-other-course",
    } as never);

    await expect(
      addLateResult("assessment-1", {
        enrollmentId: "enr-1",
        mark: 10,
        attendanceStatus: "PRESENT",
      })
    ).rejects.toThrow("ENROLLMENT_NOT_FOUND");
    expect(prisma.assessmentResult.create).not.toHaveBeenCalled();
  });

  it("rejects a no-longer-active enrollment", async () => {
    vi.mocked(prisma.studentCourseEnrollment.findUnique).mockResolvedValue({
      ...activeEnrollment,
      status: "DROPPED",
    } as never);

    await expect(
      addLateResult("assessment-1", {
        enrollmentId: "enr-1",
        mark: 10,
        attendanceStatus: "PRESENT",
      })
    ).rejects.toThrow("ENROLLMENT_NOT_FOUND");
  });

  it("never offers this on a student who already has a result — blocked with ALREADY_HAS_RESULT", async () => {
    vi.mocked(prisma.assessmentResult.findUnique).mockResolvedValue({
      id: "result-existing",
      status: "PUBLISHED",
    } as never);

    await expect(
      addLateResult("assessment-1", {
        enrollmentId: "enr-1",
        mark: 10,
        attendanceStatus: "PRESENT",
      })
    ).rejects.toThrow("ALREADY_HAS_RESULT");
    expect(prisma.assessmentResult.create).not.toHaveBeenCalled();
  });

  it("creates a new DRAFT result and audits LATE_RESULT_ADDED, without touching any other result", async () => {
    const result = await addLateResult("assessment-1", {
      enrollmentId: "enr-1",
      mark: 87,
      attendanceStatus: "PRESENT",
    });

    expect(prisma.assessmentResult.create).toHaveBeenCalledWith({
      data: {
        assessmentId: "assessment-1",
        enrollmentId: "enr-1",
        mark: 87,
        attendanceStatus: "PRESENT",
        status: "DRAFT",
        enteredBy: "user-1",
        groupId: null,
      },
    });
    expect(prisma.assessmentResult.updateMany).not.toHaveBeenCalled();
    expect(prisma.assessmentResult.update).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        action: "LATE_RESULT_ADDED",
        entity: "AssessmentResult",
        entityId: "result-new",
        newValue: expect.objectContaining({
          studentId: "student-1",
          enrollmentId: "enr-1",
          mark: 87,
        }),
      })
    );
    expect(result).toEqual({
      resultId: "result-new",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("stores a null mark when attendance isn't PRESENT", async () => {
    await addLateResult("assessment-1", {
      enrollmentId: "enr-1",
      mark: null,
      attendanceStatus: "ABSENT",
    });

    expect(prisma.assessmentResult.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ mark: null, attendanceStatus: "ABSENT" }),
      })
    );
  });
});

describe("publishLateResult", () => {
  const publishedAssessment = { id: "assessment-1", status: "PUBLISHED" };
  const draftResult = {
    id: "result-1",
    assessmentId: "assessment-1",
    status: "DRAFT",
    mark: 55,
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    vi.mocked(requireAssessmentOwner).mockResolvedValue({
      user: mockUser,
      assessment: publishedAssessment,
    } as never);
    vi.mocked(prisma.assessmentResult.findUniqueOrThrow).mockResolvedValue(
      draftResult as never
    );
  });

  it("enforces assessment.publish and ownership before touching anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(publishLateResult("assessment-1", "result-1")).rejects.toThrow(
      "FORBIDDEN"
    );
    expect(prisma.assessmentResult.update).not.toHaveBeenCalled();
  });

  it("rejects when the assessment isn't PUBLISHED", async () => {
    vi.mocked(requireAssessmentOwner).mockResolvedValue({
      user: mockUser,
      assessment: { ...publishedAssessment, status: "DRAFT" },
    } as never);

    await expect(publishLateResult("assessment-1", "result-1")).rejects.toThrow(
      "NOT_PUBLISHED"
    );
    expect(prisma.assessmentResult.update).not.toHaveBeenCalled();
  });

  it("rejects a result that belongs to a different assessment", async () => {
    vi.mocked(prisma.assessmentResult.findUniqueOrThrow).mockResolvedValue({
      ...draftResult,
      assessmentId: "some-other-assessment",
    } as never);

    await expect(publishLateResult("assessment-1", "result-1")).rejects.toThrow(
      "NOT_FOUND"
    );
    expect(prisma.assessmentResult.update).not.toHaveBeenCalled();
  });

  it("rejects a result that's already published", async () => {
    vi.mocked(prisma.assessmentResult.findUniqueOrThrow).mockResolvedValue({
      ...draftResult,
      status: "PUBLISHED",
    } as never);

    await expect(publishLateResult("assessment-1", "result-1")).rejects.toThrow(
      "ALREADY_PUBLISHED"
    );
    expect(prisma.assessmentResult.update).not.toHaveBeenCalled();
  });

  it("publishes exactly this one result and audits LATE_RESULT_PUBLISHED", async () => {
    await publishLateResult("assessment-1", "result-1");

    expect(prisma.assessmentResult.update).toHaveBeenCalledWith({
      where: { id: "result-1" },
      data: expect.objectContaining({
        status: "PUBLISHED",
        publishedBy: "user-1",
      }),
    });
    expect(prisma.assessmentResult.updateMany).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        action: "LATE_RESULT_PUBLISHED",
        entity: "AssessmentResult",
        entityId: "result-1",
      })
    );
  });
});

describe("carried-over marks after a class transfer are read-only for the NEW lecturer", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue({ id: "new-lecturer" } as never);
  });

  // A carried-over mark lives on the OLD class's assessment (owned by the
  // old lecturer) and the TRANSFERRED enrollment — results are never moved.
  // Trying to edit it through that assessment is rejected by the ownership
  // check before anything is written.
  it("saveResult on the old class's assessment is rejected by requireAssessmentOwner and writes nothing", async () => {
    vi.mocked(requireAssessmentOwner).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(
      saveResult("old-class-assessment", {
        enrollmentId: "transferred-enrollment",
        mark: 10,
        attendanceStatus: "PRESENT",
        currentUpdatedAt: null,
      })
    ).rejects.toThrow("FORBIDDEN");
    expect(requireAssessmentOwner).toHaveBeenCalledWith("old-class-assessment");
    expect(prisma.assessmentResult.create).not.toHaveBeenCalled();
    expect(prisma.assessmentResult.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
