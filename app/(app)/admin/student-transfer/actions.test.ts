import { describe, it, expect, vi, beforeEach } from "vitest";

// A tiny in-memory, TRANSACTIONAL fake of exactly the Prisma surface the
// transfer touches. $transaction snapshots the state and restores it if the
// callback throws — so "rolls back completely" is exercised for real, not
// just asserted against a mock call shape. The shared auto-enroll helper
// (lib/enrollment.ts) and the dean where-builders stay REAL.
const fake = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  type Tables = Record<string, Row[]>;
  const state: { t: Tables; seq: number; failOn: string | null } = { t: {}, seq: 0, failOn: null };

  const byId = (table: string, id: unknown) => state.t[table].find((r) => r.id === id);
  const relations: Record<string, Record<string, (r: Row) => unknown>> = {
    students: { class: (r) => byId("classes", r.classId) },
    classes: { program: (r) => byId("programs", r.programId) },
    enrollments: {
      course: (r) => byId("courses", r.courseId),
      class: (r) => byId("classes", r.classId),
      semester: (r) => byId("semesters", r.semesterId),
      student: (r) => byId("students", r.studentId),
    },
    assignments: {
      course: (r) => byId("courses", r.courseId),
      semester: (r) => byId("semesters", r.semesterId),
      lecturer: (r) => byId("lecturers", r.lecturerId),
    },
    results: {
      assessment: (r) => {
        const a = byId("assessments", r.assessmentId)!;
        return {
          ...a,
          assessmentType: { name: "Quiz" },
          assignment: { lecturer: byId("lecturers", byId("assignments", a.assignmentId)!.lecturerId) },
        };
      },
    },
    groupMembers: { group: (r) => byId("groups", r.groupId) },
  };
  const relTable: Record<string, string> = {
    class: "classes", program: "programs", course: "courses", semester: "semesters",
    student: "students", lecturer: "lecturers", assessment: "assessments", group: "groups",
  };

  function match(table: string, row: Row, where: Row | undefined): boolean {
    if (!where) return true;
    return Object.entries(where).every(([k, v]) => {
      if (k === "OR") return (v as Row[]).some((w) => match(table, row, w));
      const rel = relations[table]?.[k];
      if (rel) {
        const target = rel(row) as Row | undefined;
        return !!target && match(relTable[k] ?? k, target, v as Row);
      }
      if (v !== null && typeof v === "object" && !(v instanceof Date)) {
        const o = v as Row;
        if ("in" in o) return (o.in as unknown[]).includes(row[k]);
        if ("not" in o) return row[k] !== o.not;
      }
      return row[k] === v;
    });
  }
  function hydrate(table: string, row: Row): Row {
    const out: Row = { ...row };
    for (const [k, fn] of Object.entries(relations[table] ?? {})) out[k] = fn(row);
    return out;
  }
  function model(table: string) {
    const guard = (op: string) => {
      if (state.failOn === `${table}.${op}`) throw new Error("SIMULATED_DB_FAILURE");
    };
    return {
      findMany: async (args: { where?: Row } = {}) =>
        state.t[table].filter((r) => match(table, r, args.where)).map((r) => hydrate(table, r)),
      findFirst: async (args: { where?: Row } = {}) => {
        const r = state.t[table].find((row) => match(table, row, args.where));
        return r ? hydrate(table, r) : null;
      },
      findUnique: async (args: { where: Row }) => {
        const r = state.t[table].find((row) => match(table, row, args.where));
        return r ? hydrate(table, r) : null;
      },
      create: async ({ data }: { data: Row }) => {
        guard("create");
        const row = { id: `new-${++state.seq}`, status: "ACTIVE", transferredToId: null, ...data };
        state.t[table].push(row);
        return row;
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        guard("update");
        const r = state.t[table].find((row) => row.id === where.id)!;
        Object.assign(r, data);
        return r;
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        guard("updateMany");
        const rows = state.t[table].filter((r) => match(table, r, where));
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      },
      deleteMany: async ({ where }: { where: Row }) => {
        guard("deleteMany");
        const before = state.t[table].length;
        state.t[table] = state.t[table].filter((r) => !match(table, r, where));
        return { count: before - state.t[table].length };
      },
    };
  }

  const prisma = {
    student: model("students"),
    class: model("classes"),
    semester: model("semesters"),
    studentCourseEnrollment: model("enrollments"),
    lecturerCourseAssignment: model("assignments"),
    assessmentResult: model("results"),
    groupMember: model("groupMembers"),
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      const snapshot = structuredClone(state.t);
      try {
        return await cb(prisma);
      } catch (e) {
        state.t = snapshot;
        throw e;
      }
    }),
  };
  return { state, prisma };
});

vi.mock("@/lib/db", () => ({
  prisma: fake.prisma,
  BULK_TRANSACTION_OPTIONS: { timeout: 30000, maxWait: 10000 },
}));
vi.mock("@/lib/auth", () => ({ requirePermission: vi.fn(), getUserAccess: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/dean-scope", async (orig) => ({
  ...(await orig<typeof import("@/lib/dean-scope")>()),
  getDeanDepartmentIds: vi.fn(),
}));

import { requirePermission, getUserAccess } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getDeanDepartmentIds } from "@/lib/dean-scope";
import { getCarriedOverMarks } from "@/lib/carry-over";
import { previewStudentClassTransfer, transferStudentClass } from "./actions";

function seed() {
  fake.state.seq = 0;
  fake.state.failOn = null;
  fake.state.t = {
    programs: [
      { id: "prog-1", departmentId: "dept-1" },
      { id: "prog-2", departmentId: "dept-2" },
    ],
    classes: [
      { id: "class-a", name: "CMS-3A", currentSemesterNumber: 3, programId: "prog-1", deletedAt: null },
      { id: "class-b", name: "CMS-3B", currentSemesterNumber: 3, programId: "prog-1", deletedAt: null },
      { id: "class-x", name: "OTHER-1", currentSemesterNumber: 1, programId: "prog-2", deletedAt: null },
      { id: "class-empty", name: "EMPTY", currentSemesterNumber: 3, programId: "prog-1", deletedAt: null },
    ],
    semesters: [
      { id: "sem-old", name: "Semester 2", isActive: false, isClosed: true },
      { id: "sem-now", name: "Semester 1", isActive: true, isClosed: false },
    ],
    courses: [
      { id: "c-db", name: "Databases" },
      { id: "c-net", name: "Networking" },
      { id: "c-ai", name: "AI" },
    ],
    lecturers: [
      { id: "lec-old", fullName: "Dr. Old" },
      { id: "lec-new", fullName: "Dr. New" },
    ],
    students: [
      { id: "stu-1", studentNo: "S001", fullName: "Amina", classId: "class-a", isActive: true },
      { id: "stu-2", studentNo: "S002", fullName: "Inactive", classId: "class-a", isActive: false },
      { id: "stu-x", studentNo: "S099", fullName: "Other Faculty", classId: "class-x", isActive: true },
    ],
    assignments: [
      // Old class (A) this semester: Databases + Networking
      { id: "as-a-db", classId: "class-a", courseId: "c-db", semesterId: "sem-now", lecturerId: "lec-old" },
      { id: "as-a-net", classId: "class-a", courseId: "c-net", semesterId: "sem-now", lecturerId: "lec-old" },
      // New class (B) this semester: Databases (shared) + AI (new only)
      { id: "as-b-db", classId: "class-b", courseId: "c-db", semesterId: "sem-now", lecturerId: "lec-new" },
      { id: "as-b-ai", classId: "class-b", courseId: "c-ai", semesterId: "sem-now", lecturerId: "lec-new" },
    ],
    enrollments: [
      // closed-semester history — must never change
      { id: "en-old-closed", studentId: "stu-1", courseId: "c-db", classId: "class-a", semesterId: "sem-old", status: "COMPLETED", transferredToId: null },
      { id: "en-a-db", studentId: "stu-1", courseId: "c-db", classId: "class-a", semesterId: "sem-now", status: "ACTIVE", transferredToId: null },
      { id: "en-a-net", studentId: "stu-1", courseId: "c-net", classId: "class-a", semesterId: "sem-now", status: "ACTIVE", transferredToId: null },
      { id: "en-2", studentId: "stu-2", courseId: "c-db", classId: "class-a", semesterId: "sem-now", status: "ACTIVE", transferredToId: null },
    ],
    assessments: [
      { id: "asm-old-q1", assignmentId: "as-a-db", title: "Quiz 1", maximumMarks: 10, createdAt: new Date(1), deletedAt: null },
      { id: "asm-old-q2", assignmentId: "as-a-db", title: "Quiz 2", maximumMarks: 10, createdAt: new Date(2), deletedAt: null },
    ],
    results: [
      { id: "res-q1", assessmentId: "asm-old-q1", enrollmentId: "en-a-db", mark: 8.5, attendanceStatus: "PRESENT", isCorrected: false, status: "PUBLISHED", groupId: "grp-a" },
      { id: "res-q2", assessmentId: "asm-old-q2", enrollmentId: "en-a-db", mark: 6, attendanceStatus: "PRESENT", isCorrected: false, status: "DRAFT", groupId: null },
      { id: "res-closed", assessmentId: "asm-old-q1", enrollmentId: "en-old-closed", mark: 5, attendanceStatus: "PRESENT", isCorrected: false, status: "PUBLISHED", groupId: null },
    ],
    groups: [{ id: "grp-a", name: "Group A", assignmentId: "as-a-db" }],
    groupMembers: [{ id: "gm-1", groupId: "grp-a", studentId: "stu-1", assignmentId: "as-a-db" }],
  };
}

const rows = (table: string) => fake.state.t[table] as Record<string, unknown>[];
const enrollment = (id: string) => rows("enrollments").find((e) => e.id === id)!;

function asAdmin() {
  vi.mocked(getUserAccess).mockResolvedValue({ permissions: new Set(), roleNames: ["ADMIN"] } as never);
}
function asDean(depts: string[]) {
  vi.mocked(getUserAccess).mockResolvedValue({ permissions: new Set(), roleNames: ["DEAN"] } as never);
  vi.mocked(getDeanDepartmentIds).mockResolvedValue(depts);
}

beforeEach(() => {
  vi.clearAllMocks();
  seed();
  vi.mocked(requirePermission).mockResolvedValue({ id: "admin-1" } as never);
  asAdmin();
});

describe("permission", () => {
  it("both actions require students.transfer", async () => {
    await previewStudentClassTransfer({ studentId: "stu-1", targetClassId: "class-b" });
    await transferStudentClass({ studentId: "stu-1", targetClassId: "class-b", acknowledgeNoCourses: false });
    expect(vi.mocked(requirePermission).mock.calls.map((c) => c[0])).toEqual([
      "students.transfer",
      "students.transfer",
    ]);
  });

  it("stops before touching anything when the permission check fails", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));
    await expect(
      transferStudentClass({ studentId: "stu-1", targetClassId: "class-b", acknowledgeNoCourses: false })
    ).rejects.toThrow("FORBIDDEN");
    expect(fake.prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("preview", () => {
  it("shows transferred (carry-over vs archived), created, and groups-left lines", async () => {
    const plan = await previewStudentClassTransfer({ studentId: "stu-1", targetClassId: "class-b" });
    expect(plan.fromClass.label).toBe("CMS-3A (Semester 3)");
    expect(plan.toClass.label).toBe("CMS-3B (Semester 3)");
    expect(plan.toTransfer).toEqual([
      expect.objectContaining({ enrollmentId: "en-a-db", courseName: "Databases", carriesOver: true, publishedMarkCount: 1 }),
      expect.objectContaining({ enrollmentId: "en-a-net", courseName: "Networking", carriesOver: false }),
    ]);
    expect(plan.toCreate.map((c) => c.courseName).sort()).toEqual(["AI", "Databases"]);
    expect(plan.groupsToLeave).toEqual([{ groupId: "grp-a", groupName: "Group A", courseName: "Databases" }]);
    expect(plan.targetHasNoCourses).toBe(false);
    // Preview writes nothing.
    expect(enrollment("en-a-db").status).toBe("ACTIVE");
  });
});

describe("transferStudentClass", () => {
  it("moves the class, transfers active-semester enrollments, auto-enrolls, links shared courses, leaves groups", async () => {
    const result = await transferStudentClass({
      studentId: "stu-1",
      targetClassId: "class-b",
      acknowledgeNoCourses: false,
    });

    expect(result).toEqual({ transferredCount: 2, createdCount: 2, linkedCount: 1, groupsLeft: 1 });
    expect(rows("students").find((s) => s.id === "stu-1")!.classId).toBe("class-b");

    // Old enrollments kept as TRANSFERRED, never deleted.
    expect(enrollment("en-a-db").status).toBe("TRANSFERRED");
    expect(enrollment("en-a-net").status).toBe("TRANSFERRED");

    const created = rows("enrollments").filter((e) => e.classId === "class-b");
    expect(created.map((e) => e.courseId).sort()).toEqual(["c-ai", "c-db"]);
    const newDb = created.find((e) => e.courseId === "c-db")!;
    expect(newDb.status).toBe("ACTIVE");
    // Shared course -> chain link; old-only course -> no link (archive).
    expect(enrollment("en-a-db").transferredToId).toBe(newDb.id);
    expect(enrollment("en-a-net").transferredToId).toBeNull();

    // Group membership gone; the existing result keeps its group reference.
    expect(rows("groupMembers")).toHaveLength(0);
    expect(rows("results").find((r) => r.id === "res-q1")!.groupId).toBe("grp-a");
    // Results are NEVER moved or copied.
    expect(rows("results")).toHaveLength(3);
    expect(rows("results").find((r) => r.id === "res-q1")!.enrollmentId).toBe("en-a-db");

    expect(fake.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 30000,
      maxWait: 10000,
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "STUDENT_CLASS_TRANSFERRED",
        entity: "Student",
        entityId: "stu-1",
        userId: "admin-1",
        oldValue: expect.objectContaining({ classId: "class-a" }),
        newValue: expect.objectContaining({
          classId: "class-b",
          enrollmentsTransferred: 2,
          enrollmentsCreated: 2,
          enrollmentsLinked: 1,
          groupsLeft: 1,
        }),
      })
    );
  });

  it("never touches closed-semester enrollments or results", async () => {
    const before = structuredClone(enrollment("en-old-closed"));
    await transferStudentClass({ studentId: "stu-1", targetClassId: "class-b", acknowledgeNoCourses: false });
    expect(enrollment("en-old-closed")).toEqual(before);
    expect(rows("results").find((r) => r.id === "res-closed")).toMatchObject({ enrollmentId: "en-old-closed", mark: 5 });
  });

  it("when the active semester is closed, only the class changes — no enrollment or group is touched", async () => {
    rows("semesters").find((s) => s.id === "sem-now")!.isClosed = true;
    const result = await transferStudentClass({
      studentId: "stu-1",
      targetClassId: "class-b",
      acknowledgeNoCourses: false,
    });
    expect(result).toEqual({ transferredCount: 0, createdCount: 0, linkedCount: 0, groupsLeft: 0 });
    expect(rows("students").find((s) => s.id === "stu-1")!.classId).toBe("class-b");
    expect(enrollment("en-a-db").status).toBe("ACTIVE");
    expect(rows("enrollments")).toHaveLength(4);
    expect(rows("groupMembers")).toHaveLength(1);
  });

  it("rolls back EVERYTHING when a write fails mid-transaction", async () => {
    fake.state.failOn = "groupMembers.deleteMany"; // the very last write
    const before = structuredClone(fake.state.t);
    await expect(
      transferStudentClass({ studentId: "stu-1", targetClassId: "class-b", acknowledgeNoCourses: false })
    ).rejects.toThrow("SIMULATED_DB_FAILURE");
    expect(fake.state.t).toEqual(before);
    expect(rows("students").find((s) => s.id === "stu-1")!.classId).toBe("class-a");
    expect(audit).not.toHaveBeenCalled();
  });

  it("blocks an inactive student with a clear message", async () => {
    await expect(
      transferStudentClass({ studentId: "stu-2", targetClassId: "class-b", acknowledgeNoCourses: false })
    ).rejects.toThrow(/Inactive is inactive/);
    expect(fake.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects transferring into the student's current class", async () => {
    await expect(
      previewStudentClassTransfer({ studentId: "stu-1", targetClassId: "class-a" })
    ).rejects.toThrow(/already in that class/);
  });

  it("requires explicit acknowledgement when the target class has no courses this semester", async () => {
    await expect(
      transferStudentClass({ studentId: "stu-1", targetClassId: "class-empty", acknowledgeNoCourses: false })
    ).rejects.toThrow(/no course assignments/);
    expect(rows("students").find((s) => s.id === "stu-1")!.classId).toBe("class-a");

    const result = await transferStudentClass({
      studentId: "stu-1",
      targetClassId: "class-empty",
      acknowledgeNoCourses: true,
    });
    expect(result.createdCount).toBe(0);
    expect(result.transferredCount).toBe(2);
    expect(enrollment("en-a-db").transferredToId).toBeNull();
  });

  it("blocks a second transfer of the same course in one semester (full unique index)", async () => {
    await transferStudentClass({ studentId: "stu-1", targetClassId: "class-b", acknowledgeNoCourses: false });
    await expect(
      transferStudentClass({ studentId: "stu-1", targetClassId: "class-a", acknowledgeNoCourses: false })
    ).rejects.toThrow(/already transferred out of Databases/);
  });
});

describe("dean scoping", () => {
  it("a dean can transfer within their own faculty", async () => {
    asDean(["dept-1"]);
    const result = await transferStudentClass({
      studentId: "stu-1",
      targetClassId: "class-b",
      acknowledgeNoCourses: false,
    });
    expect(result.transferredCount).toBe(2);
  });

  it("a dean cannot transfer INTO a class outside their faculty", async () => {
    asDean(["dept-1"]);
    await expect(
      transferStudentClass({ studentId: "stu-1", targetClassId: "class-x", acknowledgeNoCourses: true })
    ).rejects.toThrow(/Target class not found/);
    expect(fake.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("a dean cannot transfer a student whose CURRENT class is outside their faculty", async () => {
    asDean(["dept-1"]);
    await expect(
      transferStudentClass({ studentId: "stu-x", targetClassId: "class-b", acknowledgeNoCourses: false })
    ).rejects.toThrow(/Student not found/);
    expect(fake.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("an unassigned dean can transfer no one", async () => {
    asDean([]);
    await expect(
      previewStudentClassTransfer({ studentId: "stu-1", targetClassId: "class-b" })
    ).rejects.toThrow(/Student not found/);
  });
});

describe("carry-over via the enrollment chain (after a real transfer)", () => {
  it("the new enrollment shows the old class's PUBLISHED marks, labeled, display-only", async () => {
    await transferStudentClass({ studentId: "stu-1", targetClassId: "class-b", acknowledgeNoCourses: false });
    const newDb = rows("enrollments").find((e) => e.classId === "class-b" && e.courseId === "c-db")!;

    const carried = await getCarriedOverMarks([newDb.id as string]);
    expect(carried[newDb.id as string]).toEqual([
      {
        enrollmentId: "en-a-db",
        classLabel: "CMS-3A (Semester 3)",
        lecturerName: "Dr. Old",
        semesterName: "Semester 1",
        // Quiz 2 is still DRAFT in the old class -> never carried over.
        marks: [
          {
            assessmentId: "asm-old-q1",
            title: "Quiz 1",
            typeName: "Quiz",
            mark: 8.5,
            maximumMarks: 10,
            attendanceStatus: "PRESENT",
            isCorrected: false,
          },
        ],
        earned: 8.5,
        possible: 10,
      },
    ]);
    // Display-only: no result id / optimistic-lock token is exposed, so
    // nothing from here can be fed to saveResult/correctResult.
    const mark = carried[newDb.id as string][0].marks[0] as unknown as Record<string, unknown>;
    expect(mark).not.toHaveProperty("resultId");
    expect(mark).not.toHaveProperty("updatedAt");

    // The AI enrollment (new-only course) has nothing carried over.
    const newAi = rows("enrollments").find((e) => e.classId === "class-b" && e.courseId === "c-ai")!;
    expect((await getCarriedOverMarks([newAi.id as string]))[newAi.id as string]).toBeUndefined();
  });
});
