import { describe, it, expect } from "vitest";
import {
  buildPreviewStateByClass,
  scheduleChipInClass,
  moveSessionInClass,
  editSessionTimeInClass,
  editSessionRoomInClass,
  unscheduleSessionInClass,
  setCrossPeriodOverrideInClass,
  classPreviewCounts,
  flattenSessionsForCommit,
  otherClassesAsConflictCandidates,
  classSessionsAsConflictCandidates,
  type PreviewAssignmentMeta,
  type ClassPreviewState,
} from "./auto-timetable-preview-state";
import type { ScheduledSession, UnscheduledItem } from "./auto-timetable";
import type { LecturerAvailabilityDayRule } from "./timetable-days";

const dayOnly = (day: "SAT" | "WED" | "THU" | "FRI"): LecturerAvailabilityDayRule => ({ dayOfWeek: day, shifts: [] });

function session(overrides: Partial<ScheduledSession> = {}): ScheduledSession {
  return {
    assignmentId: "assign-1",
    classId: "class-1",
    className: "CMS26-A-FT",
    courseName: "Databases",
    lecturerId: "lect-1",
    lecturerName: "Dr. Ahmed",
    lecturerAvailability: [],
    roomId: "room-1",
    roomName: "Room 101 — Main Campus",
    dayOfWeek: "SAT",
    startTime: "08:00",
    endTime: "09:30",
    shiftId: "shift-1",
    shiftName: "Subax 1aad",
    sessionNumber: 1,
    sessionCount: 1,
    ...overrides,
  };
}

function unscheduled(overrides: Partial<UnscheduledItem> = {}): UnscheduledItem {
  return {
    assignmentId: "assign-2",
    classId: "class-1",
    className: "CMS26-A-FT",
    courseName: "Networks",
    lecturerName: "Dr. Yusuf",
    lecturerAvailability: [],
    reason: "No valid day/shift combination remains for this session.",
    shiftId: "shift-1",
    shiftName: "Subax 1aad",
    sessionNumber: 1,
    sessionCount: 1,
    ...overrides,
  };
}

const meta: PreviewAssignmentMeta = {
  assignmentId: "assign-2",
  classId: "class-1",
  className: "CMS26-A-FT",
  courseName: "Networks",
  lecturerId: "lect-2",
  lecturerName: "Dr. Yusuf",
  lecturerAvailability: [],
  roomId: "room-1",
  roomLabel: "Room 101 — Main Campus",
};

describe("buildPreviewStateByClass", () => {
  it("groups normal, fallback, and unscheduled entries by class", () => {
    const state = buildPreviewStateByClass({
      scheduledNormally: [session()],
      scheduledWithFallback: [session({ assignmentId: "assign-3", sessionNumber: 1, dayOfWeek: "SUN" })],
      unscheduled: [unscheduled()],
    });
    expect(state.size).toBe(1);
    const cls = state.get("class-1")!;
    expect(cls.sessions).toHaveLength(2);
    expect(cls.chips).toHaveLength(1);
    expect(cls.sessions.find((s) => s.assignmentId === "assign-1")!.flagged).toBe(false);
    expect(cls.sessions.find((s) => s.assignmentId === "assign-3")!.flagged).toBe(true);
    expect(cls.chips[0].id).toBe("assign-2:1");
  });

  it("carries lecturerAvailability through onto both sessions and chips", () => {
    const state = buildPreviewStateByClass({
      scheduledNormally: [session({ lecturerAvailability: [dayOnly("SAT"), dayOnly("WED")] })],
      scheduledWithFallback: [],
      unscheduled: [unscheduled({ lecturerAvailability: [dayOnly("THU"), dayOnly("FRI")] })],
    });
    const cls = state.get("class-1")!;
    expect(cls.sessions[0].lecturerAvailability).toEqual([dayOnly("SAT"), dayOnly("WED")]);
    expect(cls.chips[0].lecturerAvailability).toEqual([dayOnly("THU"), dayOnly("FRI")]);
  });

  it("always seeds crossPeriodOverride false — the algorithm never sets it", () => {
    const state = buildPreviewStateByClass({
      scheduledNormally: [session()],
      scheduledWithFallback: [session({ assignmentId: "assign-3" })],
      unscheduled: [],
    });
    const cls = state.get("class-1")!;
    expect(cls.sessions.every((s) => s.crossPeriodOverride === false)).toBe(true);
  });

  it("splits sessions across multiple classes", () => {
    const state = buildPreviewStateByClass({
      scheduledNormally: [session(), session({ assignmentId: "assign-9", classId: "class-2", className: "CMS26-B-FT" })],
      scheduledWithFallback: [],
      unscheduled: [],
    });
    expect(state.size).toBe(2);
    expect(state.get("class-2")!.sessions).toHaveLength(1);
  });
});

describe("scheduleChipInClass", () => {
  it("promotes a chip into a placed session when the slot is free", () => {
    const state = buildPreviewStateByClass({ scheduledNormally: [], scheduledWithFallback: [], unscheduled: [unscheduled()] });
    const cls = state.get("class-1")!;
    const result = scheduleChipInClass(cls, "assign-2:1", "MON", { id: "shift-2", startTime: "10:00", endTime: "11:30" }, meta, []);
    expect(result.ok).toBe(true);
    expect(result.cls.chips).toHaveLength(0);
    expect(result.cls.sessions).toHaveLength(1);
    expect(result.cls.sessions[0]).toMatchObject({
      id: "assign-2:1",
      dayOfWeek: "MON",
      startTime: "10:00",
      endTime: "11:30",
      roomId: "room-1",
      lecturerId: "lect-2",
      flagged: false,
    });
  });

  it("copies the meta's lecturerAvailability onto the resulting session (a chip carries no lecturerId to look it up from)", () => {
    const state = buildPreviewStateByClass({ scheduledNormally: [], scheduledWithFallback: [], unscheduled: [unscheduled()] });
    const cls = state.get("class-1")!;
    const result = scheduleChipInClass(
      cls,
      "assign-2:1",
      "MON",
      { id: "shift-2", startTime: "10:00", endTime: "11:30" },
      { ...meta, lecturerAvailability: [dayOnly("SAT"), dayOnly("WED")] },
      []
    );
    expect(result.ok).toBe(true);
    expect(result.cls.sessions[0].lecturerAvailability).toEqual([dayOnly("SAT"), dayOnly("WED")]);
  });

  it("rejects a drop that conflicts with the class's own existing session", () => {
    const state = buildPreviewStateByClass({ scheduledNormally: [session()], scheduledWithFallback: [], unscheduled: [unscheduled()] });
    const cls = state.get("class-1")!;
    // Same day+time as the already-placed session, same class -> CLASS conflict.
    const result = scheduleChipInClass(cls, "assign-2:1", "SAT", { id: "shift-1", startTime: "08:00", endTime: "09:30" }, meta, []);
    expect(result.ok).toBe(false);
    expect(result.conflicts!.length).toBeGreaterThan(0);
    // Nothing changed.
    expect(result.cls.chips).toHaveLength(1);
    expect(result.cls.sessions).toHaveLength(1);
  });

  it("rejects a drop that conflicts with another class via external candidates (room clash)", () => {
    const state = buildPreviewStateByClass({ scheduledNormally: [], scheduledWithFallback: [], unscheduled: [unscheduled()] });
    const cls = state.get("class-1")!;
    const external = [
      {
        id: "other",
        dayOfWeek: "MON" as const,
        startTime: "10:00",
        endTime: "11:30",
        roomId: "room-1",
        roomName: "Room 101 — Main Campus",
        lecturerId: "lect-9",
        lecturerName: "Dr. Other",
        classId: "class-2",
        className: "CMS26-B-FT",
        courseName: "Other course",
      },
    ];
    const result = scheduleChipInClass(cls, "assign-2:1", "MON", { id: "shift-2", startTime: "10:00", endTime: "11:30" }, meta, external);
    expect(result.ok).toBe(false);
    expect(result.conflicts![0].kind).toBe("ROOM");
  });

  it("marks the session crossPeriodOverride when dropped onto a cross-period row", () => {
    const state = buildPreviewStateByClass({ scheduledNormally: [], scheduledWithFallback: [], unscheduled: [unscheduled()] });
    const cls = state.get("class-1")!;
    const result = scheduleChipInClass(
      cls,
      "assign-2:1",
      "MON",
      { id: "shift-galab-1", startTime: "13:00", endTime: "14:30", crossPeriod: true },
      meta,
      []
    );
    expect(result.ok).toBe(true);
    expect(result.cls.sessions[0].crossPeriodOverride).toBe(true);
  });

  it("leaves crossPeriodOverride false when dropped onto a normal (own-period) row", () => {
    const state = buildPreviewStateByClass({ scheduledNormally: [], scheduledWithFallback: [], unscheduled: [unscheduled()] });
    const cls = state.get("class-1")!;
    const result = scheduleChipInClass(cls, "assign-2:1", "MON", { id: "shift-2", startTime: "10:00", endTime: "11:30" }, meta, []);
    expect(result.ok).toBe(true);
    expect(result.cls.sessions[0].crossPeriodOverride).toBe(false);
  });

  it("returns unchanged (not-ok) for an unknown chip id", () => {
    void buildPreviewStateByClass({ scheduledNormally: [], scheduledWithFallback: [], unscheduled: [] });
    const cls: ClassPreviewState = {
      classId: "class-1",
      className: "CMS26-A-FT",
      sessions: [],
      chips: [],
    };
    const result = scheduleChipInClass(cls, "missing", "MON", { id: "shift-2", startTime: "10:00", endTime: "11:30" }, meta, []);
    expect(result.ok).toBe(false);
    expect(result.cls).toBe(cls);
  });
});

describe("moveSessionInClass", () => {
  it("moves a placed session to a free cell and clears its flagged status", () => {
    const state = buildPreviewStateByClass({ scheduledNormally: [], scheduledWithFallback: [session()], unscheduled: [] });
    const cls = state.get("class-1")!;
    expect(cls.sessions[0].flagged).toBe(true);
    const result = moveSessionInClass(cls, cls.sessions[0].id, "SUN", { id: "shift-2", startTime: "10:00", endTime: "11:30" }, []);
    expect(result.ok).toBe(true);
    expect(result.cls.sessions[0]).toMatchObject({ dayOfWeek: "SUN", startTime: "10:00", endTime: "11:30", flagged: false });
  });

  it("marks crossPeriodOverride when moved onto a cross-period row", () => {
    const state = buildPreviewStateByClass({ scheduledNormally: [session()], scheduledWithFallback: [], unscheduled: [] });
    const cls = state.get("class-1")!;
    const result = moveSessionInClass(
      cls,
      cls.sessions[0].id,
      "SUN",
      { id: "shift-galab-1", startTime: "13:00", endTime: "14:30", crossPeriod: true },
      []
    );
    expect(result.ok).toBe(true);
    expect(result.cls.sessions[0].crossPeriodOverride).toBe(true);
  });

  it("clears crossPeriodOverride when a cross-period session is moved back onto a normal row", () => {
    const cls: ClassPreviewState = {
      classId: "class-1",
      className: "CMS26-A-FT",
      sessions: [
        {
          id: "x",
          assignmentId: "assign-9",
          classId: "class-1",
          courseName: "Networks",
          lecturerId: "lect-2",
          lecturerName: "Dr. Yusuf",
          lecturerAvailability: [],
          roomId: "room-1",
          roomLabel: "Room 101 — Main Campus",
          dayOfWeek: "SUN",
          startTime: "13:00",
          endTime: "14:30",
          sessionNumber: 1,
          sessionCount: 1,
          flagged: false,
          crossPeriodOverride: true,
        },
      ],
      chips: [],
    };
    const result = moveSessionInClass(cls, "x", "SUN", { id: "shift-2", startTime: "10:00", endTime: "11:30" }, []);
    expect(result.ok).toBe(true);
    expect(result.cls.sessions[0].crossPeriodOverride).toBe(false);
  });

  it("rejects a move that would self-conflict is impossible, but a genuine clash with a classmate is rejected", () => {
    const state = buildPreviewStateByClass({
      scheduledNormally: [session(), session({ assignmentId: "assign-9", sessionNumber: 1, dayOfWeek: "SUN", startTime: "10:00", endTime: "11:30" })],
      scheduledWithFallback: [],
      unscheduled: [],
    });
    const cls = state.get("class-1")!;
    const moving = cls.sessions.find((s) => s.assignmentId === "assign-1")!;
    const result = moveSessionInClass(cls, moving.id, "SUN", { id: "shift-2", startTime: "10:00", endTime: "11:30" }, []);
    expect(result.ok).toBe(false);
    expect(result.conflicts!.some((c) => c.kind === "CLASS")).toBe(true);
  });
});

describe("editSessionTimeInClass", () => {
  it("no-ops when the patch matches the existing time", () => {
    const state = buildPreviewStateByClass({ scheduledNormally: [session()], scheduledWithFallback: [], unscheduled: [] });
    const cls = state.get("class-1")!;
    const result = editSessionTimeInClass(cls, cls.sessions[0].id, { startTime: "08:00" }, []);
    expect(result.ok).toBe(true);
    expect(result.cls).toBe(cls);
  });

  it("applies a valid retime and clears flagged", () => {
    const state = buildPreviewStateByClass({ scheduledNormally: [], scheduledWithFallback: [session()], unscheduled: [] });
    const cls = state.get("class-1")!;
    const result = editSessionTimeInClass(cls, cls.sessions[0].id, { startTime: "09:00", endTime: "10:30" }, []);
    expect(result.ok).toBe(true);
    expect(result.cls.sessions[0]).toMatchObject({ startTime: "09:00", endTime: "10:30", flagged: false });
  });

  it("preserves the existing crossPeriodOverride flag when the 5th param is omitted (a plain retype)", () => {
    const state = buildPreviewStateByClass({ scheduledNormally: [session()], scheduledWithFallback: [], unscheduled: [] });
    const cls = state.get("class-1")!;
    const marked = { ...cls, sessions: [{ ...cls.sessions[0], crossPeriodOverride: true }] };
    const result = editSessionTimeInClass(marked, marked.sessions[0].id, { startTime: "09:00", endTime: "10:30" }, []);
    expect(result.ok).toBe(true);
    expect(result.cls.sessions[0].crossPeriodOverride).toBe(true);
  });

  it("sets crossPeriodOverride explicitly when provided — this is how the inline cross-period shift picker applies it", () => {
    const state = buildPreviewStateByClass({ scheduledNormally: [session()], scheduledWithFallback: [], unscheduled: [] });
    const cls = state.get("class-1")!;
    const result = editSessionTimeInClass(cls, cls.sessions[0].id, { startTime: "13:00", endTime: "14:30" }, [], true);
    expect(result.ok).toBe(true);
    expect(result.cls.sessions[0].crossPeriodOverride).toBe(true);
  });

  it("no-ops when neither time nor crossPeriodOverride actually changes", () => {
    const state = buildPreviewStateByClass({ scheduledNormally: [session()], scheduledWithFallback: [], unscheduled: [] });
    const cls = state.get("class-1")!;
    const result = editSessionTimeInClass(cls, cls.sessions[0].id, {}, [], false);
    expect(result.ok).toBe(true);
    expect(result.cls).toBe(cls);
  });
});

describe("setCrossPeriodOverrideInClass", () => {
  it("sets the flag true without touching day/time/room", () => {
    const state = buildPreviewStateByClass({ scheduledNormally: [session()], scheduledWithFallback: [], unscheduled: [] });
    const cls = state.get("class-1")!;
    const result = setCrossPeriodOverrideInClass(cls, cls.sessions[0].id, true);
    expect(result.ok).toBe(true);
    expect(result.cls.sessions[0]).toMatchObject({
      crossPeriodOverride: true,
      dayOfWeek: cls.sessions[0].dayOfWeek,
      startTime: cls.sessions[0].startTime,
      roomId: cls.sessions[0].roomId,
    });
  });

  it("clears the flag back to false", () => {
    const state = buildPreviewStateByClass({ scheduledNormally: [session()], scheduledWithFallback: [], unscheduled: [] });
    const cls = state.get("class-1")!;
    const marked = { ...cls, sessions: [{ ...cls.sessions[0], crossPeriodOverride: true }] };
    const result = setCrossPeriodOverrideInClass(marked, marked.sessions[0].id, false);
    expect(result.ok).toBe(true);
    expect(result.cls.sessions[0].crossPeriodOverride).toBe(false);
  });

  it("is a no-op (same object reference) when the value already matches", () => {
    const state = buildPreviewStateByClass({ scheduledNormally: [session()], scheduledWithFallback: [], unscheduled: [] });
    const cls = state.get("class-1")!;
    const result = setCrossPeriodOverrideInClass(cls, cls.sessions[0].id, false);
    expect(result.ok).toBe(true);
    expect(result.cls).toBe(cls);
  });

  it("returns unchanged (not-ok) for an unknown session id", () => {
    const state = buildPreviewStateByClass({ scheduledNormally: [session()], scheduledWithFallback: [], unscheduled: [] });
    const cls = state.get("class-1")!;
    const result = setCrossPeriodOverrideInClass(cls, "missing", true);
    expect(result.ok).toBe(false);
    expect(result.cls).toBe(cls);
  });
});

describe("editSessionRoomInClass", () => {
  it("changes the room when free", () => {
    const state = buildPreviewStateByClass({ scheduledNormally: [session()], scheduledWithFallback: [], unscheduled: [] });
    const cls = state.get("class-1")!;
    const result = editSessionRoomInClass(cls, cls.sessions[0].id, "room-2", "Lab 1 — Main Campus", []);
    expect(result.ok).toBe(true);
    expect(result.cls.sessions[0]).toMatchObject({ roomId: "room-2", roomLabel: "Lab 1 — Main Campus" });
  });

  it("rejects a room already booked by another class at the same day/time", () => {
    const state = buildPreviewStateByClass({ scheduledNormally: [session()], scheduledWithFallback: [], unscheduled: [] });
    const cls = state.get("class-1")!;
    const external = [
      {
        id: "other",
        dayOfWeek: "SAT" as const,
        startTime: "08:00",
        endTime: "09:30",
        roomId: "room-2",
        roomName: "Lab 1",
        lecturerId: "lect-9",
        lecturerName: "Dr. Other",
        classId: "class-2",
        className: "CMS26-B-FT",
        courseName: "Other course",
      },
    ];
    const result = editSessionRoomInClass(cls, cls.sessions[0].id, "room-2", "Lab 1", external);
    expect(result.ok).toBe(false);
    expect(result.conflicts![0].kind).toBe("ROOM");
  });
});

describe("unscheduleSessionInClass", () => {
  it("moves a placed session back into chips with a manual reason", () => {
    const state = buildPreviewStateByClass({ scheduledNormally: [session()], scheduledWithFallback: [], unscheduled: [] });
    const cls = state.get("class-1")!;
    const next = unscheduleSessionInClass(cls, cls.sessions[0].id);
    expect(next.sessions).toHaveLength(0);
    expect(next.chips).toHaveLength(1);
    expect(next.chips[0]).toMatchObject({ id: "assign-1:1", reason: "Manually unscheduled." });
  });
});

describe("classPreviewCounts", () => {
  it("counts scheduled, unscheduled, and flagged", () => {
    const state = buildPreviewStateByClass({
      scheduledNormally: [session()],
      scheduledWithFallback: [session({ assignmentId: "assign-3" })],
      unscheduled: [unscheduled()],
    });
    expect(classPreviewCounts(state.get("class-1")!)).toEqual({ scheduled: 2, unscheduled: 1, flagged: 1 });
  });
});

describe("flattenSessionsForCommit", () => {
  it("flattens every class's scheduled sessions into commit rows, excluding chips", () => {
    const state = buildPreviewStateByClass({
      scheduledNormally: [session(), session({ assignmentId: "assign-9", classId: "class-2", className: "CMS26-B-FT" })],
      scheduledWithFallback: [],
      unscheduled: [unscheduled()],
    });
    const rows = flattenSessionsForCommit(state);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ assignmentId: "assign-1", classId: "class-1", roomId: "room-1" }),
        expect.objectContaining({ assignmentId: "assign-9", classId: "class-2" }),
      ])
    );
  });
});

describe("otherClassesAsConflictCandidates / classSessionsAsConflictCandidates", () => {
  it("excludes the given class and includes every other class's sessions", () => {
    const state = buildPreviewStateByClass({
      scheduledNormally: [session(), session({ assignmentId: "assign-9", classId: "class-2", className: "CMS26-B-FT" })],
      scheduledWithFallback: [],
      unscheduled: [],
    });
    const candidates = otherClassesAsConflictCandidates(state, "class-1");
    expect(candidates).toHaveLength(1);
    expect(candidates[0].classId).toBe("class-2");

    const own = classSessionsAsConflictCandidates(state.get("class-1")!);
    expect(own).toHaveLength(1);
    expect(own[0].classId).toBe("class-1");
  });
});
