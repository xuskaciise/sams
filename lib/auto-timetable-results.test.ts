import { describe, it, expect } from "vitest";
import { groupGenerationResult } from "./auto-timetable-results";
import type { ScheduledSession, UnscheduledItem } from "./auto-timetable";

function session(overrides: Partial<ScheduledSession> = {}): ScheduledSession {
  return {
    assignmentId: "assign-1",
    classId: "class-1",
    className: "CMS26-CMS-4A-FT",
    courseName: "Databases",
    lecturerId: "lect-1",
    lecturerName: "Dr. Ahmed",
    roomId: "room-1",
    roomName: "Room 101",
    dayOfWeek: "SAT",
    startTime: "08:00",
    endTime: "09:00",
    shiftId: "shift-1",
    shiftName: "Shift 1",
    sessionNumber: 1,
    sessionCount: 1,
    ...overrides,
  };
}

function unscheduledItem(overrides: Partial<UnscheduledItem> = {}): UnscheduledItem {
  return {
    assignmentId: "assign-2",
    classId: "class-1",
    className: "CMS26-CMS-4A-FT",
    courseName: "Networking",
    lecturerName: "Dr. Fatima",
    reason: "No valid day/shift combination remains for this session.",
    shiftId: "shift-1",
    shiftName: "Shift 1",
    sessionNumber: 1,
    sessionCount: 1,
    ...overrides,
  };
}

describe("groupGenerationResult", () => {
  it("groups sessions by class, then by course+lecturer", () => {
    const result = groupGenerationResult({
      scheduledNormally: [session()],
      scheduledWithFallback: [],
      unscheduled: [],
    });
    expect(result.classes).toHaveLength(1);
    expect(result.classes[0].classId).toBe("class-1");
    expect(result.classes[0].assignments).toHaveLength(1);
    expect(result.classes[0].assignments[0].courseName).toBe("Databases");
  });

  it("labels multi-session assignments with sessionNumber/sessionCount, sorted ascending", () => {
    const result = groupGenerationResult({
      scheduledNormally: [
        session({ sessionNumber: 2, sessionCount: 2, dayOfWeek: "SUN" }),
        session({ sessionNumber: 1, sessionCount: 2, dayOfWeek: "SAT" }),
      ],
      scheduledWithFallback: [],
      unscheduled: [],
    });
    const [assignment] = result.classes[0].assignments;
    expect(assignment.sessions.map((s) => s.sessionNumber)).toEqual([1, 2]);
    expect(assignment.sessions.every((s) => s.sessionCount === 2)).toBe(true);
  });

  it("keeps two different classes as separate groups, sorted by className", () => {
    const result = groupGenerationResult({
      scheduledNormally: [
        session({ classId: "class-b", className: "CMS26-B-FT" }),
        session({ classId: "class-a", className: "CMS26-A-FT" }),
      ],
      scheduledWithFallback: [],
      unscheduled: [],
    });
    expect(result.classes.map((c) => c.className)).toEqual(["CMS26-A-FT", "CMS26-B-FT"]);
  });

  it("marks a fallback session with status 'fallback' and a note", () => {
    const result = groupGenerationResult({
      scheduledNormally: [],
      scheduledWithFallback: [session({ dayOfWeek: "SAT" })],
      unscheduled: [],
    });
    const [row] = result.classes[0].assignments[0].sessions;
    expect(row.status).toBe("fallback");
    expect(row.fallbackNote).toContain("Double-booked on Saturday");
  });

  it("computes per-class and overall totals across normal/fallback/unscheduled", () => {
    const result = groupGenerationResult({
      scheduledNormally: [session({ assignmentId: "a1" })],
      scheduledWithFallback: [session({ assignmentId: "a2" })],
      unscheduled: [unscheduledItem({ assignmentId: "a3" })],
    });
    expect(result.classes[0].countNormal).toBe(1);
    expect(result.classes[0].countFallback).toBe(1);
    expect(result.classes[0].countUnscheduled).toBe(1);
    expect(result.totals).toEqual({ normal: 1, fallback: 1, unscheduled: 1 });
  });

  it("sums totals across MULTIPLE classes", () => {
    const result = groupGenerationResult({
      scheduledNormally: [
        session({ classId: "class-a", className: "A" }),
        session({ classId: "class-b", className: "B" }),
      ],
      scheduledWithFallback: [session({ classId: "class-a", className: "A", assignmentId: "a2" })],
      unscheduled: [unscheduledItem({ classId: "class-b", className: "B" })],
    });
    expect(result.totals).toEqual({ normal: 2, fallback: 1, unscheduled: 1 });
  });

  it("deduplicates identical unscheduled reasons within a class into one group with multiple items", () => {
    const sameReason = "No valid day/shift combination remains for this session.";
    const result = groupGenerationResult({
      scheduledNormally: [],
      scheduledWithFallback: [],
      unscheduled: [
        unscheduledItem({ assignmentId: "a1", courseName: "Databases", reason: sameReason }),
        unscheduledItem({ assignmentId: "a2", courseName: "Networking", reason: sameReason }),
        unscheduledItem({ assignmentId: "a3", courseName: "Security", reason: "A totally different reason." }),
      ],
    });
    const groups = result.classes[0].unscheduledReasonGroups;
    expect(groups).toHaveLength(2); // deduplicated: 2 distinct reason strings, not 3 rows
    const bigGroup = groups.find((g) => g.reason === sameReason)!;
    expect(bigGroup.items).toHaveLength(2);
    expect(bigGroup.items.map((i) => i.courseName).sort()).toEqual(["Databases", "Networking"]);
  });

  it("orders reason groups by how many sessions are affected, most first", () => {
    const result = groupGenerationResult({
      scheduledNormally: [],
      scheduledWithFallback: [],
      unscheduled: [
        unscheduledItem({ assignmentId: "a1", reason: "Rare reason" }),
        unscheduledItem({ assignmentId: "a2", courseName: "B", reason: "Common reason" }),
        unscheduledItem({ assignmentId: "a3", courseName: "C", reason: "Common reason" }),
      ],
    });
    expect(result.classes[0].unscheduledReasonGroups[0].reason).toBe("Common reason");
    expect(result.classes[0].unscheduledReasonGroups[0].items).toHaveLength(2);
  });

  it("keeps unscheduled reason groups scoped per class — same reason in two classes stays separate", () => {
    const sameReason = "No valid day/shift combination remains for this session.";
    const result = groupGenerationResult({
      scheduledNormally: [],
      scheduledWithFallback: [],
      unscheduled: [
        unscheduledItem({ classId: "class-a", className: "A", reason: sameReason }),
        unscheduledItem({ classId: "class-b", className: "B", reason: sameReason }),
      ],
    });
    expect(result.classes).toHaveLength(2);
    expect(result.classes[0].unscheduledReasonGroups).toHaveLength(1);
    expect(result.classes[1].unscheduledReasonGroups).toHaveLength(1);
  });

  it("an assignment with one scheduled and one unscheduled session appears in both places", () => {
    const result = groupGenerationResult({
      scheduledNormally: [session({ assignmentId: "a1", sessionNumber: 1, sessionCount: 2 })],
      scheduledWithFallback: [],
      unscheduled: [
        unscheduledItem({
          assignmentId: "a1",
          courseName: "Databases",
          sessionNumber: 2,
          sessionCount: 2,
        }),
      ],
    });
    const classGroup = result.classes[0];
    expect(classGroup.assignments).toHaveLength(1);
    expect(classGroup.assignments[0].sessions).toHaveLength(1); // only session 1
    expect(classGroup.assignments[0].sessions[0].sessionNumber).toBe(1);
    const reasonItem = classGroup.unscheduledReasonGroups[0].items[0];
    expect(reasonItem.sessionNumber).toBe(2);
    expect(reasonItem.sessionCount).toBe(2);
  });

  it("returns an empty classes array and zeroed totals for an empty result", () => {
    const result = groupGenerationResult({ scheduledNormally: [], scheduledWithFallback: [], unscheduled: [] });
    expect(result.classes).toEqual([]);
    expect(result.totals).toEqual({ normal: 0, fallback: 0, unscheduled: 0 });
  });
});
