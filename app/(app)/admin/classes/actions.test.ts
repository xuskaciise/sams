import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    program: { findUniqueOrThrow: vi.fn() },
    class: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    timetableSlot: { findMany: vi.fn() },
  },
}));

import { requirePermission } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import {
  createClass,
  updateClass,
  previewBulkClassPeriodUpdate,
  bulkUpdateClassPeriod,
} from "./actions";

const mockAdmin = { id: "admin-1" };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requirePermission).mockResolvedValue(mockAdmin as never);
  vi.mocked(prisma.class.findFirst).mockResolvedValue(null);
  vi.mocked(prisma.program.findUniqueOrThrow).mockResolvedValue({
    id: "program-1",
    code: "CMS",
  } as never);
});

describe("createClass", () => {
  it("enforces structure.manage before touching anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(
      createClass({
        programId: "program-1",
        intakeYear: 2026,
        section: "A",
        studyMode: "FT",
      })
    ).rejects.toThrow("FORBIDDEN");
    expect(prisma.class.create).not.toHaveBeenCalled();
  });

  it("derives batchCode from the program's code + the last 2 digits of intake year — never free-typed", async () => {
    await createClass({
      programId: "program-1",
      intakeYear: 2026,
      section: "A",
      studyMode: "FT",
      period: "MORNING",
    });

    expect(prisma.program.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: "program-1" },
    });
    expect(prisma.class.create).toHaveBeenCalledWith({
      data: {
        programId: "program-1",
        name: "CMS26-A-FT",
        batchCode: "CMS26",
        intakeYear: 2026,
        section: "A",
        studyMode: "FT",
        period: "MORNING",
        currentSemesterNumber: null,
        roomId: null,
      },
    });
  });

  it("carries an explicit roomId through — optional at create time, required only at build/generate time", async () => {
    await createClass({
      programId: "program-1",
      intakeYear: 2026,
      section: "A",
      studyMode: "FT",
      period: "MORNING",
      roomId: "room-1",
    });

    expect(prisma.class.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ roomId: "room-1" }) })
    );
  });

  it("requires period for an FT class — rejected before ever reaching the DB", async () => {
    await expect(
      createClass({
        programId: "program-1",
        intakeYear: 2026,
        section: "A",
        studyMode: "FT",
      })
    ).rejects.toThrow();
    expect(prisma.class.create).not.toHaveBeenCalled();
  });

  it("forces period to null for a PT class even if somehow submitted — PT has no period concept", async () => {
    await createClass({
      programId: "program-1",
      intakeYear: 2026,
      section: "B",
      studyMode: "PT",
    });

    expect(prisma.class.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ period: null }) })
    );
  });

  it("takes the last 2 digits even for a year ending in a single-digit-looking tail (e.g. 2005 -> 05)", async () => {
    await createClass({
      programId: "program-1",
      intakeYear: 2005,
      section: "B",
      studyMode: "PT",
    });

    expect(prisma.class.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ batchCode: "CMS05" }) })
    );
  });

  it("falls back to the manually-typed name and a null batchCode/intakeYear when intake year, section, or study mode is missing", async () => {
    await createClass({ programId: "program-1", name: "Legacy Class" });

    expect(prisma.program.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(prisma.class.create).toHaveBeenCalledWith({
      data: {
        programId: "program-1",
        name: "Legacy Class",
        batchCode: null,
        intakeYear: null,
        section: null,
        studyMode: null,
        period: null,
        currentSemesterNumber: null,
        roomId: null,
      },
    });
  });

  it("rejects a duplicate batchCode+section+studyMode combination — the composed name already implies it", async () => {
    vi.mocked(prisma.class.findFirst).mockResolvedValue({
      id: "existing-class",
    } as never);

    await expect(
      createClass({
        programId: "program-1",
        intakeYear: 2026,
        section: "A",
        studyMode: "FT",
        period: "MORNING",
      })
    ).rejects.toThrow('A class named "CMS26-A-FT" already exists in this program.');
    expect(prisma.class.create).not.toHaveBeenCalled();
  });

  it("scopes the duplicate check to programId + the composed name", async () => {
    await createClass({
      programId: "program-1",
      intakeYear: 2026,
      section: "A",
      studyMode: "FT",
      period: "MORNING",
    });

    expect(prisma.class.findFirst).toHaveBeenCalledWith({
      where: { programId: "program-1", name: "CMS26-A-FT" },
    });
  });
});

describe("updateClass", () => {
  it("recomputes batchCode from the submitted intake year (e.g. correcting a mistake), rather than keeping the old stored value", async () => {
    await updateClass("class-1", {
      programId: "program-1",
      intakeYear: 2027,
      section: "A",
      studyMode: "FT",
      period: "MORNING",
    });

    expect(prisma.class.update).toHaveBeenCalledWith({
      where: { id: "class-1" },
      data: expect.objectContaining({ batchCode: "CMS27", intakeYear: 2027 }),
    });
  });

  it("excludes itself from the duplicate check, so re-saving unchanged succeeds", async () => {
    await updateClass("class-1", {
      programId: "program-1",
      intakeYear: 2026,
      section: "A",
      studyMode: "FT",
      period: "MORNING",
    });

    expect(prisma.class.findFirst).toHaveBeenCalledWith({
      where: {
        programId: "program-1",
        name: "CMS26-A-FT",
        NOT: { id: "class-1" },
      },
    });
  });

  it("rejects renaming into a collision with a DIFFERENT existing class", async () => {
    vi.mocked(prisma.class.findFirst).mockResolvedValue({
      id: "other-class",
    } as never);

    await expect(
      updateClass("class-1", {
        programId: "program-1",
        intakeYear: 2026,
        section: "A",
        studyMode: "FT",
        period: "MORNING",
      })
    ).rejects.toThrow('A class named "CMS26-A-FT" already exists in this program.');
    expect(prisma.class.update).not.toHaveBeenCalled();
  });

  it("does NOT inherit period from a predecessor — a promoted class's period is whatever is explicitly submitted", async () => {
    await updateClass("class-1", {
      programId: "program-1",
      intakeYear: 2026,
      section: "A",
      studyMode: "FT",
      period: "AFTERNOON",
    });

    expect(prisma.class.update).toHaveBeenCalledWith({
      where: { id: "class-1" },
      data: expect.objectContaining({ period: "AFTERNOON" }),
    });
  });
});

describe("previewBulkClassPeriodUpdate", () => {
  it("enforces structure.manage before touching anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));
    await expect(previewBulkClassPeriodUpdate(["class-1"])).rejects.toThrow("FORBIDDEN");
    expect(prisma.class.findMany).not.toHaveBeenCalled();
  });

  it("returns an empty array without querying when no ids are given", async () => {
    const result = await previewBulkClassPeriodUpdate([]);
    expect(result).toEqual([]);
    expect(prisma.class.findMany).not.toHaveBeenCalled();
  });

  it("resolves each class's current period and whether it already has TimetableSlots", async () => {
    vi.mocked(prisma.class.findMany).mockResolvedValue([
      { id: "class-1", name: "CMS26-A-FT", period: "MORNING" },
      { id: "class-2", name: "CMS26-B-FT", period: null },
    ] as never);
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([
      { assignment: { classId: "class-1" } },
    ] as never);

    const result = await previewBulkClassPeriodUpdate(["class-1", "class-2"]);

    expect(result).toEqual([
      { classId: "class-1", className: "CMS26-A-FT", currentPeriod: "MORNING", hasExistingSlots: true },
      { classId: "class-2", className: "CMS26-B-FT", currentPeriod: null, hasExistingSlots: false },
    ]);
  });

  it("scopes the class lookup to FT only — never trusts the client's own filtering", async () => {
    vi.mocked(prisma.class.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([] as never);
    await previewBulkClassPeriodUpdate(["class-1"]);
    expect(prisma.class.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["class-1"] }, studyMode: "FT" },
      })
    );
  });
});

describe("bulkUpdateClassPeriod", () => {
  beforeEach(() => {
    vi.mocked(prisma.class.findMany).mockResolvedValue([
      { id: "class-1", name: "CMS26-A-FT", period: "MORNING" },
      { id: "class-2", name: "CMS26-B-FT", period: null },
    ] as never);
  });

  it("enforces structure.manage before writing anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));
    await expect(
      bulkUpdateClassPeriod({ classIds: ["class-1"], newPeriod: "AFTERNOON" })
    ).rejects.toThrow("FORBIDDEN");
    expect(prisma.class.updateMany).not.toHaveBeenCalled();
  });

  it("updates every eligible class's period in one updateMany call", async () => {
    const result = await bulkUpdateClassPeriod({
      classIds: ["class-1", "class-2"],
      newPeriod: "AFTERNOON",
    });

    expect(prisma.class.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["class-1", "class-2"] } },
      data: { period: "AFTERNOON" },
    });
    expect(result).toEqual({ updated: 2, skipped: 0 });
  });

  it("re-verifies FT-only server-side, skipping any id that isn't (or is no longer) an FT class", async () => {
    vi.mocked(prisma.class.findMany).mockResolvedValue([
      { id: "class-1", name: "CMS26-A-FT", period: "MORNING" },
    ] as never);

    const result = await bulkUpdateClassPeriod({
      classIds: ["class-1", "class-2"],
      newPeriod: "AFTERNOON",
    });

    expect(prisma.class.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["class-1"] } },
      data: { period: "AFTERNOON" },
    });
    expect(result).toEqual({ updated: 1, skipped: 1 });
  });

  it("rejects when none of the submitted ids are eligible, without writing", async () => {
    vi.mocked(prisma.class.findMany).mockResolvedValue([]);
    await expect(
      bulkUpdateClassPeriod({ classIds: ["class-1"], newPeriod: "AFTERNOON" })
    ).rejects.toThrow();
    expect(prisma.class.updateMany).not.toHaveBeenCalled();
  });

  it("audits the old->new period per class, and who did it", async () => {
    await bulkUpdateClassPeriod({ classIds: ["class-1", "class-2"], newPeriod: "AFTERNOON" });

    expect(audit).toHaveBeenCalledWith({
      userId: "admin-1",
      action: "CLASS_PERIOD_BULK_UPDATED",
      entity: "Class",
      oldValue: {
        classes: [
          { classId: "class-1", className: "CMS26-A-FT", period: "MORNING" },
          { classId: "class-2", className: "CMS26-B-FT", period: null },
        ],
      },
      newValue: {
        newPeriod: "AFTERNOON",
        classes: [
          { classId: "class-1", className: "CMS26-A-FT" },
          { classId: "class-2", className: "CMS26-B-FT" },
        ],
      },
    });
  });
});
