import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    program: { findUniqueOrThrow: vi.fn() },
    class: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  },
}));

import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { createClass, updateClass } from "./actions";

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
        currentSemesterNumber: null,
      },
    });
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
        currentSemesterNumber: null,
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
      })
    ).rejects.toThrow('A class named "CMS26-A-FT" already exists in this program.');
    expect(prisma.class.update).not.toHaveBeenCalled();
  });
});
