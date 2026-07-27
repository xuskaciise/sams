"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, Loader2, Plus, Trash2 } from "lucide-react";
import type { DayOfWeek } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { getActionErrorMessage } from "@/lib/action-error";
import { getValidDaysForStudyMode, DAY_LABELS } from "@/lib/timetable-days";
import type { TimetablePanelData } from "./queries";
import { buildClassTimetable, type BuildTimetableViolation } from "./actions";

interface SessionRow {
  key: string;
  dayOfWeek: DayOfWeek;
  lecturerCourseAssignmentId: string;
  startTime: string;
  endTime: string;
  roomId: string;
}

function newRow(day: DayOfWeek): SessionRow {
  return {
    key: crypto.randomUUID(),
    dayOfWeek: day,
    lecturerCourseAssignmentId: "",
    startTime: "",
    endTime: "",
    roomId: "",
  };
}

function isRowComplete(row: SessionRow): boolean {
  return !!(row.lecturerCourseAssignmentId && row.startTime && row.endTime && row.roomId);
}

export function BuildTimetableClient({
  classes,
  assignments,
  rooms,
  shifts,
  semesters,
  activeSemesterId,
}: Pick<
  TimetablePanelData,
  "classes" | "assignments" | "rooms" | "shifts" | "semesters" | "activeSemesterId"
>) {
  const router = useRouter();
  const [classId, setClassId] = useState("");
  const [semesterId, setSemesterId] = useState(activeSemesterId);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [violations, setViolations] = useState<Record<string, string[]>>({});
  const [submitting, setSubmitting] = useState(false);

  const selectedClass = classes.find((c) => c.id === classId) ?? null;
  const validDays = getValidDaysForStudyMode(selectedClass?.studyMode ?? null) ?? [
    "SAT",
    "SUN",
    "MON",
    "TUE",
    "WED",
    "THU",
    "FRI",
  ];

  const assignmentOptionsForClass = useMemo(
    () => assignments.filter((a) => a.classId === classId && a.semesterId === semesterId),
    [assignments, classId, semesterId]
  );

  // Every session added here already belongs to the one selected class,
  // so unlike the single-slot dialog (which can target any class) this
  // only ever needs ONE studyMode-filtered list, shared by every row.
  const shiftsForClass = selectedClass
    ? shifts.filter((s) => s.studyMode === selectedClass.studyMode)
    : [];

  function resetBuilder(nextClassId: string) {
    setClassId(nextClassId);
    setSessions([]);
    setViolations({});
  }

  function addSession(day: DayOfWeek) {
    setSessions((prev) => [...prev, newRow(day)]);
  }

  function removeSession(key: string) {
    setSessions((prev) => prev.filter((s) => s.key !== key));
    setViolations((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([k]) => k !== key))
    );
  }

  function updateSession(key: string, patch: Partial<SessionRow>) {
    setSessions((prev) => prev.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  }

  const allRowsComplete = sessions.length > 0 && sessions.every(isRowComplete);

  function groupViolations(list: BuildTimetableViolation[]): Record<string, string[]> {
    const grouped: Record<string, string[]> = {};
    for (const v of list) {
      grouped[v.sessionKey] = [...(grouped[v.sessionKey] ?? []), v.message];
    }
    return grouped;
  }

  async function handleSubmit() {
    if (!classId || !semesterId || !allRowsComplete) return;

    setSubmitting(true);
    setViolations({});
    try {
      const result = await buildClassTimetable({
        classId,
        semesterId,
        sessions: sessions.map(({ key, dayOfWeek, lecturerCourseAssignmentId, startTime, endTime, roomId }) => ({
          key,
          dayOfWeek,
          lecturerCourseAssignmentId,
          startTime,
          endTime,
          roomId,
        })),
      });

      if (result.ok) {
        toast.success(`Timetable built — ${result.created} session${result.created === 1 ? "" : "s"} created.`);
        resetBuilder("");
        router.refresh();
      } else {
        setViolations(groupViolations(result.violations));
        toast.error(
          `${result.violations.length} problem${result.violations.length === 1 ? "" : "s"} found — nothing was saved. Fix the highlighted sessions and submit again.`
        );
      }
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not build the timetable. Please try again."));
    } finally {
      setSubmitting(false);
    }
  }

  const hasViolations = Object.keys(violations).length > 0;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Build a class&rsquo;s entire week in one go. Pick a class and semester, add sessions
        to any of its valid teaching days, then submit — the whole week is created together,
        or not at all if anything conflicts.
      </p>

      <div className="flex flex-wrap gap-2">
        <div className="w-56">
          <SearchableSelect
            value={classId}
            onValueChange={resetBuilder}
            items={classes.map((c) => ({ value: c.id, label: c.name }))}
            placeholder="Select a class"
            searchPlaceholder="Search classes…"
            className="w-full"
          />
        </div>
        <div className="w-64">
          <SearchableSelect
            value={semesterId}
            onValueChange={(value) => {
              setSemesterId(value);
              setSessions([]);
              setViolations({});
            }}
            items={semesters.map((s) => ({
              value: s.id,
              label: `${s.name} (${s.academicYear.name})${s.isActive ? " — active" : ""}`,
            }))}
            placeholder="Select a semester"
            searchPlaceholder="Search semesters…"
            className="w-full"
          />
        </div>
      </div>

      {!selectedClass && (
        <p className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
          Pick a class to start building its week.
        </p>
      )}

      {selectedClass && !selectedClass.studyMode && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
          This class has no study mode set, so every day of the week is offered here. Set its
          study mode (FT/PT) under Academic Structure to narrow this to its real teaching days.
        </p>
      )}

      {selectedClass && assignmentOptionsForClass.length === 0 && (
        <p className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
          This class has no course assignments for the selected semester yet — nothing to
          schedule. Assign courses to it first.
        </p>
      )}

      {selectedClass && assignmentOptionsForClass.length > 0 && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {validDays.map((day) => {
              const daySessions = sessions.filter((s) => s.dayOfWeek === day);
              return (
                <div
                  key={day}
                  className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3"
                >
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold">{DAY_LABELS[day]}</p>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={() => addSession(day)}
                    >
                      <Plus className="size-3.5" />
                      Add session
                    </Button>
                  </div>

                  <div className="flex flex-col gap-3">
                    {daySessions.map((row) => (
                      <div
                        key={row.key}
                        className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-2"
                      >
                        <div className="flex items-start justify-between gap-1">
                          <div className="w-full">
                            <SearchableSelect
                              value={row.lecturerCourseAssignmentId}
                              onValueChange={(value) =>
                                updateSession(row.key, { lecturerCourseAssignmentId: value })
                              }
                              items={assignmentOptionsForClass.map((a) => ({
                                value: a.id,
                                label: `${a.course.name} (${a.lecturer.user.fullName})`,
                                keywords: [a.course.name, a.lecturer.user.fullName],
                              }))}
                              placeholder="Course"
                              searchPlaceholder="Search courses…"
                              className="w-full"
                            />
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            className="shrink-0"
                            onClick={() => removeSession(row.key)}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>

                        {shiftsForClass.length > 0 && (
                          <SearchableSelect
                            value=""
                            onValueChange={(shiftId) => {
                              const shift = shiftsForClass.find((s) => s.id === shiftId);
                              if (!shift) return;
                              updateSession(row.key, {
                                startTime: shift.startTime,
                                endTime: shift.endTime,
                              });
                            }}
                            items={shiftsForClass.map((s) => ({
                              value: s.id,
                              label: `${s.name} (${s.startTime}–${s.endTime})`,
                            }))}
                            placeholder="No shift — custom time"
                            searchPlaceholder="Search shifts…"
                            className="w-full"
                          />
                        )}

                        <div className="grid grid-cols-2 gap-2">
                          <Input
                            type="time"
                            value={row.startTime}
                            onChange={(e) => updateSession(row.key, { startTime: e.target.value })}
                          />
                          <Input
                            type="time"
                            value={row.endTime}
                            onChange={(e) => updateSession(row.key, { endTime: e.target.value })}
                          />
                        </div>

                        <SearchableSelect
                          value={row.roomId}
                          onValueChange={(value) => updateSession(row.key, { roomId: value })}
                          items={rooms.map((r) => ({
                            value: r.id,
                            label: `${r.name} — ${r.campus.name}`,
                            keywords: [r.campus.name],
                          }))}
                          placeholder="Room"
                          searchPlaceholder="Search rooms or campuses…"
                          className="w-full"
                        />

                        {violations[row.key] && (
                          <div className="flex flex-col gap-0.5 rounded border border-destructive/30 bg-destructive/10 p-1.5 text-xs text-destructive">
                            {violations[row.key].map((message, i) => (
                              <p key={i}>{message}</p>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                    {daySessions.length === 0 && (
                      <p className="text-xs text-muted-foreground">No sessions yet</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {hasViolations && (
            <div className="flex items-center gap-1.5 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertTriangle className="size-4" />
              Nothing was saved — fix the highlighted sessions above and submit again.
            </div>
          )}

          <Button
            type="button"
            onClick={handleSubmit}
            disabled={submitting || !allRowsComplete}
            className="self-end"
          >
            {submitting && <Loader2 className="size-4 animate-spin" />}
            Build timetable ({sessions.length} session{sessions.length === 1 ? "" : "s"})
          </Button>
        </>
      )}
    </div>
  );
}
