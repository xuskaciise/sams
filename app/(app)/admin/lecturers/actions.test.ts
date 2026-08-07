import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

const mockAdmin = { id: "admin-1" };

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    lecturer: {
      create: vi.fn(),
      update: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { requirePermission } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import {
  registerLecturer,
  updateLecturerPhoneNumber,
  updateLecturerDepartment,
  updateLecturerAvailableDays,
  deleteLecturer,
} from "./actions";

function p2002(target: string[]) {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
    meta: { target },
  });
}

const validInput = {
  staffNo: "L001",
  fullName: "Dr. Amina Yusuf",
  phoneNumber: "+252611111111",
  title: "Dr.",
  departmentId: "dept-1",
  availableDays: [],
};

describe("registerLecturer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockAdmin as never);
    vi.mocked(prisma.lecturer.create).mockResolvedValue({
      id: "lect-1",
      staffNo: "L001",
      fullName: "Dr. Amina Yusuf",
    } as never);
  });

  it("requires user.manage before touching anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(registerLecturer(validInput)).rejects.toThrow("FORBIDDEN");
    expect(prisma.lecturer.create).not.toHaveBeenCalled();
  });

  it("rejects a blank phone number — it's required, unlike the student one", async () => {
    await expect(
      registerLecturer({ ...validInput, phoneNumber: "" })
    ).rejects.toThrow();
    expect(prisma.lecturer.create).not.toHaveBeenCalled();
  });

  it("creates ONLY the Lecturer profile row — no User, no account", async () => {
    await registerLecturer(validInput);

    expect(prisma.lecturer.create).toHaveBeenCalledWith({
      data: {
        staffNo: "L001",
        fullName: "Dr. Amina Yusuf",
        phoneNumber: "+252611111111",
        title: "Dr.",
        departmentId: "dept-1",
        availableDays: [],
      },
    });
  });

  it("registers a lecturer WITH availableDays set", async () => {
    await registerLecturer({ ...validInput, availableDays: ["SAT", "WED"] });

    expect(prisma.lecturer.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ availableDays: ["SAT", "WED"] }) })
    );
  });

  it("leaves department null when not provided", async () => {
    await registerLecturer({ ...validInput, departmentId: "" });

    expect(prisma.lecturer.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ departmentId: null }) })
    );
  });

  it("reports a duplicate staff_no distinctly from a duplicate phone_number", async () => {
    vi.mocked(prisma.lecturer.create).mockRejectedValueOnce(p2002(["staff_no"]));
    await expect(registerLecturer(validInput)).rejects.toThrow("STAFF_NO_TAKEN");

    vi.mocked(prisma.lecturer.create).mockRejectedValueOnce(p2002(["phone_number"]));
    await expect(registerLecturer(validInput)).rejects.toThrow("PHONE_NUMBER_TAKEN");
  });

  it("audits LECTURER_REGISTERED", async () => {
    await registerLecturer(validInput);

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "admin-1",
        action: "LECTURER_REGISTERED",
        entity: "Lecturer",
        entityId: "lect-1",
      })
    );
  });
});

describe("updateLecturerPhoneNumber", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockAdmin as never);
    vi.mocked(prisma.lecturer.findUniqueOrThrow).mockResolvedValue({
      id: "lect-1",
      phoneNumber: "+252611111111",
    } as never);
    vi.mocked(prisma.lecturer.update).mockResolvedValue({
      id: "lect-1",
      phoneNumber: "+252622222222",
    } as never);
  });

  it("rejects clearing the phone number — required for an already-registered lecturer", async () => {
    await expect(
      updateLecturerPhoneNumber("lect-1", { phoneNumber: "" })
    ).rejects.toThrow("PHONE_NUMBER_REQUIRED");
    expect(prisma.lecturer.update).not.toHaveBeenCalled();
  });

  it("saves a valid new phone number", async () => {
    await updateLecturerPhoneNumber("lect-1", { phoneNumber: "+252622222222" });

    expect(prisma.lecturer.update).toHaveBeenCalledWith({
      where: { id: "lect-1" },
      data: { phoneNumber: "+252622222222" },
    });
  });

  it("reports a conflict if the new number belongs to another lecturer", async () => {
    vi.mocked(prisma.lecturer.update).mockRejectedValue(p2002(["phone_number"]));

    await expect(
      updateLecturerPhoneNumber("lect-1", { phoneNumber: "+252622222222" })
    ).rejects.toThrow("PHONE_NUMBER_TAKEN");
  });
});

describe("updateLecturerDepartment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockAdmin as never);
    vi.mocked(prisma.lecturer.findUniqueOrThrow).mockResolvedValue({
      id: "lect-1",
      departmentId: null,
    } as never);
    vi.mocked(prisma.lecturer.update).mockResolvedValue({
      id: "lect-1",
      departmentId: "dept-2",
    } as never);
  });

  it("assigns a department to a previously-unassigned lecturer", async () => {
    await updateLecturerDepartment("lect-1", { departmentId: "dept-2" });

    expect(prisma.lecturer.update).toHaveBeenCalledWith({
      where: { id: "lect-1" },
      data: { departmentId: "dept-2" },
    });
  });

  it("clears a department back to unassigned", async () => {
    await updateLecturerDepartment("lect-1", { departmentId: "" });

    expect(prisma.lecturer.update).toHaveBeenCalledWith({
      where: { id: "lect-1" },
      data: { departmentId: null },
    });
  });
});

describe("updateLecturerAvailableDays", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockAdmin as never);
    vi.mocked(prisma.lecturer.findUniqueOrThrow).mockResolvedValue({
      id: "lect-1",
      availableDays: [],
    } as never);
    vi.mocked(prisma.lecturer.update).mockResolvedValue({
      id: "lect-1",
      availableDays: ["SAT", "WED"],
    } as never);
  });

  it("requires user.manage before touching anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(
      updateLecturerAvailableDays("lect-1", { availableDays: ["SAT"] })
    ).rejects.toThrow("FORBIDDEN");
    expect(prisma.lecturer.update).not.toHaveBeenCalled();
  });

  it("sets availableDays on a previously-unrestricted lecturer", async () => {
    await updateLecturerAvailableDays("lect-1", { availableDays: ["SAT", "WED"] });

    expect(prisma.lecturer.update).toHaveBeenCalledWith({
      where: { id: "lect-1" },
      data: { availableDays: ["SAT", "WED"] },
    });
  });

  it("clears availableDays back to unrestricted (empty array)", async () => {
    vi.mocked(prisma.lecturer.findUniqueOrThrow).mockResolvedValue({
      id: "lect-1",
      availableDays: ["SAT", "WED"],
    } as never);
    vi.mocked(prisma.lecturer.update).mockResolvedValue({
      id: "lect-1",
      availableDays: [],
    } as never);

    await updateLecturerAvailableDays("lect-1", { availableDays: [] });

    expect(prisma.lecturer.update).toHaveBeenCalledWith({
      where: { id: "lect-1" },
      data: { availableDays: [] },
    });
  });

  it("audits LECTURER_AVAILABLE_DAYS_UPDATED with old/new values", async () => {
    await updateLecturerAvailableDays("lect-1", { availableDays: ["SAT", "WED"] });

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "admin-1",
        action: "LECTURER_AVAILABLE_DAYS_UPDATED",
        entity: "Lecturer",
        entityId: "lect-1",
        oldValue: { availableDays: [] },
        newValue: { availableDays: ["SAT", "WED"] },
      })
    );
  });
});

describe("deleteLecturer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockAdmin as never);
    vi.mocked(prisma.lecturer.findUniqueOrThrow).mockResolvedValue({
      id: "lect-1",
      staffNo: "L001",
      fullName: "Dr. Amina Yusuf",
      userId: null,
      _count: { assignments: 0 },
    } as never);
  });

  it("requires user.manage before touching anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(deleteLecturer("lect-1")).rejects.toThrow("FORBIDDEN");
    expect(prisma.lecturer.delete).not.toHaveBeenCalled();
  });

  it("refuses to delete a lecturer that already has a login account", async () => {
    vi.mocked(prisma.lecturer.findUniqueOrThrow).mockResolvedValue({
      id: "lect-1",
      staffNo: "L001",
      fullName: "Dr. Amina Yusuf",
      userId: "user-9",
      _count: { assignments: 0 },
    } as never);

    await expect(deleteLecturer("lect-1")).rejects.toThrow("HAS_ACCOUNT");
    expect(prisma.lecturer.delete).not.toHaveBeenCalled();
  });

  it("refuses to delete a lecturer with existing course assignments", async () => {
    vi.mocked(prisma.lecturer.findUniqueOrThrow).mockResolvedValue({
      id: "lect-1",
      staffNo: "L001",
      fullName: "Dr. Amina Yusuf",
      userId: null,
      _count: { assignments: 2 },
    } as never);

    await expect(deleteLecturer("lect-1")).rejects.toThrow("HAS_ASSIGNMENTS");
    expect(prisma.lecturer.delete).not.toHaveBeenCalled();
  });

  it("deletes an unused lecturer profile and audits it", async () => {
    await deleteLecturer("lect-1");

    expect(prisma.lecturer.delete).toHaveBeenCalledWith({ where: { id: "lect-1" } });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "admin-1",
        action: "LECTURER_DELETED",
        entity: "Lecturer",
        entityId: "lect-1",
        oldValue: { staffNo: "L001", fullName: "Dr. Amina Yusuf" },
      })
    );
  });
});
