import { describe, it, expect } from "vitest";
import {
  timeRangesOverlap,
  findTimetableConflicts,
  type ConflictCandidateSlot,
  type ConflictCheckInput,
} from "./timetable-conflicts";

describe("timeRangesOverlap", () => {
  it("detects a genuine overlap", () => {
    expect(timeRangesOverlap("09:00", "10:30", "10:00", "11:00")).toBe(true);
  });

  it("back-to-back slots (end === start) do not overlap", () => {
    expect(timeRangesOverlap("09:00", "10:00", "10:00", "11:00")).toBe(false);
  });

  it("fully-contained ranges overlap", () => {
    expect(timeRangesOverlap("09:00", "12:00", "10:00", "10:30")).toBe(true);
  });

  it("disjoint ranges do not overlap", () => {
    expect(timeRangesOverlap("09:00", "10:00", "14:00", "15:00")).toBe(false);
  });
});

function baseCandidate(overrides: Partial<ConflictCandidateSlot> = {}): ConflictCandidateSlot {
  return {
    id: "slot-1",
    dayOfWeek: "MON",
    startTime: "09:00",
    endTime: "10:00",
    roomId: "room-1",
    roomName: "A101",
    lecturerId: "lect-1",
    lecturerName: "Dr. Ahmed",
    classId: "class-1",
    className: "CMS2518-A-FT",
    courseName: "Database Systems",
    ...overrides,
  };
}

function baseInput(overrides: Partial<ConflictCheckInput> = {}): ConflictCheckInput {
  return {
    dayOfWeek: "MON",
    startTime: "09:30",
    endTime: "10:30",
    roomId: "room-2",
    lecturerId: "lect-2",
    classId: "class-2",
    ...overrides,
  };
}

describe("findTimetableConflicts", () => {
  it("flags a room conflict when the room matches and times overlap", () => {
    const conflicts = findTimetableConflicts(
      baseInput({ roomId: "room-1" }),
      [baseCandidate()]
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe("ROOM");
  });

  it("flags a lecturer conflict when the lecturer matches and times overlap", () => {
    const conflicts = findTimetableConflicts(
      baseInput({ lecturerId: "lect-1" }),
      [baseCandidate()]
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe("LECTURER");
  });

  it("flags a class conflict when the class matches and times overlap", () => {
    const conflicts = findTimetableConflicts(
      baseInput({ classId: "class-1" }),
      [baseCandidate()]
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe("CLASS");
  });

  it("can flag multiple conflict kinds for the same overlapping slot at once", () => {
    const conflicts = findTimetableConflicts(
      baseInput({ roomId: "room-1", lecturerId: "lect-1", classId: "class-1" }),
      [baseCandidate()]
    );
    expect(conflicts.map((c) => c.kind).sort()).toEqual(["CLASS", "LECTURER", "ROOM"]);
  });

  it("no conflict when times do not overlap, even with matching room/lecturer/class", () => {
    const conflicts = findTimetableConflicts(
      baseInput({
        roomId: "room-1",
        lecturerId: "lect-1",
        classId: "class-1",
        startTime: "11:00",
        endTime: "12:00",
      }),
      [baseCandidate()]
    );
    expect(conflicts).toHaveLength(0);
  });

  it("no conflict on a different day, even with identical times", () => {
    const conflicts = findTimetableConflicts(
      baseInput({ roomId: "room-1", dayOfWeek: "TUE" }),
      [baseCandidate()]
    );
    expect(conflicts).toHaveLength(0);
  });

  it("excludes the slot being edited via excludeSlotId, so it never conflicts with itself", () => {
    const conflicts = findTimetableConflicts(
      baseInput({ roomId: "room-1", lecturerId: "lect-1", classId: "class-1" }),
      [baseCandidate({ id: "slot-1" })],
      "slot-1"
    );
    expect(conflicts).toHaveLength(0);
  });

  it("no conflict when neither room, lecturer, nor class match", () => {
    const conflicts = findTimetableConflicts(baseInput(), [baseCandidate()]);
    expect(conflicts).toHaveLength(0);
  });
});
