"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  Loader2,
  MapPin,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { getActionErrorMessage } from "@/lib/action-error";
import { classifySemesterNumbersByEligibility, describeIneligibleLevels } from "@/lib/auto-timetable";
import {
  groupGenerationResult,
  type ResultClassGroup,
  type ResultSessionRow,
} from "@/lib/auto-timetable-results";
import type { CreatedAssignmentSummary } from "../workload-import/actions";
import type { GeneratorShiftOption } from "../workload-import/generator-data";
import { previewAutoTimetableBatch, confirmAutoTimetableBatch, type PreviewBatchResult } from "./actions";

interface SemesterGroup {
  semesterId: string;
  semesterLabel: string;
  levels: number[]; // ascending, eligible Class.currentSemesterNumber values, present in this batch
  assignmentsByLevel: Map<number, CreatedAssignmentSummary[]>;
  ineligibleLevels: number[]; // present but the wrong parity for the currently active academic semester
  ineligibleAssignments: CreatedAssignmentSummary[]; // informational only — never auto-generated this cycle
}

// Which class levels are eligible THIS cycle depends on the active
// academic-calendar Semester's own semesterNumber (1 or 2) — Semester 1
// active means only ODD Class.currentSemesterNumber values are mid-cycle,
// Semester 2 means only EVEN ones. This is one institution-wide fact,
// resolved once by the caller and applied uniformly to every group here —
// never re-derived per group/assignment. See lib/auto-timetable.ts.
function buildGroups(
  assignments: CreatedAssignmentSummary[],
  activeAcademicSemesterNumber: number | null
): SemesterGroup[] {
  const bySemester = new Map<string, CreatedAssignmentSummary[]>();
  for (const a of assignments) {
    const list = bySemester.get(a.semesterId) ?? [];
    list.push(a);
    bySemester.set(a.semesterId, list);
  }

  return [...bySemester.entries()].map(([semesterId, list]) => {
    const { eligible, ineligible } = classifySemesterNumbersByEligibility(
      list.map((a) => a.classCurrentSemesterNumber),
      activeAcademicSemesterNumber
    );
    const assignmentsByLevel = new Map<number, CreatedAssignmentSummary[]>();
    for (const level of eligible) {
      assignmentsByLevel.set(
        level,
        list.filter((a) => a.classCurrentSemesterNumber === level)
      );
    }
    const ineligibleSet = new Set(ineligible);
    const ineligibleAssignments = list.filter(
      (a) => a.classCurrentSemesterNumber !== null && ineligibleSet.has(a.classCurrentSemesterNumber)
    );
    return {
      semesterId,
      semesterLabel: list[0].semesterLabel,
      levels: eligible,
      assignmentsByLevel,
      ineligibleLevels: ineligible,
      ineligibleAssignments,
    };
  });
}

interface Props {
  createdAssignments: CreatedAssignmentSummary[];
  shifts: GeneratorShiftOption[];
  // The active academic-calendar Semester's own semesterNumber (1 or 2) —
  // null when there's no active Semester or its number hasn't been set,
  // in which case nothing is eligible and every level is reported as
  // ineligible with an explanation rather than guessed. See
  // lib/auto-timetable.ts's parityForAcademicSemesterNumber.
  activeAcademicSemesterNumber: number | null;
  onClose: () => void;
}

export function AutoTimetableGeneratorClient({
  createdAssignments,
  shifts,
  activeAcademicSemesterNumber,
  onClose,
}: Props) {
  const groups = useMemo(
    () => buildGroups(createdAssignments, activeAcademicSemesterNumber),
    [createdAssignments, activeAcademicSemesterNumber]
  );
  const [groupIdx, setGroupIdx] = useState(0);
  const [levelIdx, setLevelIdx] = useState(0);
  const [shiftOverrideCounts, setShiftOverrideCounts] = useState<Record<string, Record<string, number>>>({});
  const [preview, setPreview] = useState<PreviewBatchResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmedLevels, setConfirmedLevels] = useState<Set<string>>(new Set());
  const [allDone, setAllDone] = useState(false);

  const group = groups[groupIdx] as SemesterGroup | undefined;
  const level = group?.levels[levelIdx];
  const levelKey = group && level !== undefined ? `${group.semesterId}:${level}` : null;
  const assignments = useMemo(
    () => (group && level !== undefined ? (group.assignmentsByLevel.get(level) ?? []) : []),
    [group, level]
  );

  // Room is a class-registration property now (Class.roomId, set under
  // Academic Structure > Classes) — the generator never asks for one. Any
  // class among this level's assignments with no room set is reported
  // upfront (before even calling Generate preview) with a direct link,
  // same "block for that class, not the whole page" pattern as the
  // drag-and-drop Build Timetable; its assignments are simply excluded
  // from what gets sent to the server (which re-checks this itself as a
  // defense-in-depth safety net regardless).
  const classesWithoutRoom = useMemo(() => {
    const seen = new Map<string, string>();
    for (const a of assignments) {
      if (!a.classRoomId) seen.set(a.classId, a.className);
    }
    return [...seen.entries()].map(([classId, className]) => ({ classId, className }));
  }, [assignments]);
  const schedulableAssignments = useMemo(
    () => assignments.filter((a) => a.classRoomId),
    [assignments]
  );

  if (!group || level === undefined) {
    // Nothing eligible right now — but that could genuinely be because
    // every present class level is the WRONG parity for the currently
    // active academic semester (not because there's simply nothing here).
    // Report that explicitly instead of a generic "nothing to schedule."
    const allIneligibleLevels = [...new Set(groups.flatMap((g) => g.ineligibleLevels))].sort(
      (a, b) => a - b
    );
    const ineligibleMessage = describeIneligibleLevels(allIneligibleLevels, activeAcademicSemesterNumber);
    return (
      <div className="flex flex-col gap-4">
        {ineligibleMessage ? (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <p>{ineligibleMessage}</p>
          </div>
        ) : (
          <p className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
            No classes were found among these assignments — nothing to auto-generate. Schedule these
            manually via the Timetable Builder.
          </p>
        )}
        <Button variant="outline" onClick={onClose}>
          Done
        </Button>
      </div>
    );
  }

  const isLastLevelOfGroup = levelIdx === group.levels.length - 1;
  const isLastGroup = groupIdx === groups.length - 1;

  async function handlePreview() {
    if (!group || level === undefined || schedulableAssignments.length === 0) return;
    setPreviewing(true);
    try {
      const result = await previewAutoTimetableBatch({
        semesterId: group.semesterId,
        semesterNumber: level,
        assignments: schedulableAssignments.map((a) => {
          const counts = shiftOverrideCounts[a.assignmentId];
          const overrideIds = counts
            ? Object.entries(counts).flatMap(([shiftId, count]) => Array(count).fill(shiftId))
            : [];
          return { assignmentId: a.assignmentId, shiftOverrideIds: overrideIds.length > 0 ? overrideIds : undefined };
        }),
      });
      setPreview(result);
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not generate a preview for this semester."));
    } finally {
      setPreviewing(false);
    }
  }

  async function handleConfirm() {
    if (!preview || !group || level === undefined) return;
    const sessions = [...preview.scheduledNormally, ...preview.scheduledWithFallback].map((s) => ({
      assignmentId: s.assignmentId,
      classId: s.classId,
      roomId: s.roomId,
      dayOfWeek: s.dayOfWeek,
      startTime: s.startTime,
      endTime: s.endTime,
    }));
    if (sessions.length === 0) return;
    setConfirming(true);
    try {
      const result = await confirmAutoTimetableBatch({
        semesterId: group.semesterId,
        semesterNumber: level,
        sessions,
      });
      toast.success(
        `Semester level ${level}: ${result.created} session${result.created === 1 ? "" : "s"} added to the timetable.` +
          (result.skippedDueToRaceConflict > 0
            ? ` ${result.skippedDueToRaceConflict} could not be confirmed (a conflict appeared since the preview) — check the Timetable page.`
            : "")
      );
      setConfirmedLevels((prev) => new Set(prev).add(levelKey!));
      setPreview(null);
      if (!isLastLevelOfGroup) {
        setLevelIdx((i) => i + 1);
      } else if (!isLastGroup) {
        setGroupIdx((i) => i + 1);
        setLevelIdx(0);
      } else {
        setAllDone(true);
      }
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not confirm this semester's timetable."));
    } finally {
      setConfirming(false);
    }
  }

  function adjustOverride(assignmentId: string, shiftId: string, delta: number) {
    setShiftOverrideCounts((prev) => {
      const current = prev[assignmentId] ?? {};
      const next = Math.max(0, (current[shiftId] ?? 0) + delta);
      return { ...prev, [assignmentId]: { ...current, [shiftId]: next } };
    });
  }

  const levelConfirmed = levelKey ? confirmedLevels.has(levelKey) : false;

  if (allDone) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-card p-8 text-center">
        <CheckCircle2 className="size-10 text-green-600" />
        <p className="text-lg font-semibold">All semester levels processed</p>
        <p className="text-sm text-muted-foreground">
          Every semester level eligible this cycle has been generated and confirmed.
        </p>
        <Button onClick={onClose}>Done</Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3">
        <div className="text-sm">
          <p className="font-semibold">
            {group.semesterLabel} — Semester level {level}
          </p>
          <p className="text-muted-foreground">
            Processing this cycle&rsquo;s eligible semester levels in order ({group.levels.join(" → ")}).
            Level {level} must be confirmed before the next one is offered.
          </p>
        </div>
        {levelConfirmed && (
          <Badge variant="published">
            <CheckCircle2 className="size-3" /> Confirmed
          </Badge>
        )}
      </div>

      {group.ineligibleAssignments.length > 0 && groupIdx === 0 && levelIdx === 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <p>
            {group.ineligibleAssignments.length} assignment(s) are not eligible this cycle.{" "}
            {describeIneligibleLevels(group.ineligibleLevels, activeAcademicSemesterNumber)}
          </p>
        </div>
      )}

      {classesWithoutRoom.length > 0 && (
        <div className="flex flex-col gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
          <div className="flex items-center gap-1.5 font-semibold">
            <MapPin className="size-3.5" /> {classesWithoutRoom.length} class(es) have no room assigned
          </div>
          {classesWithoutRoom.map((c) => (
            <div key={c.classId} className="flex items-center justify-between gap-2">
              <span>{c.className} — this class has no room assigned.</span>
              <Link
                href={`/admin/structure?tab=classes&editClassId=${c.classId}`}
                className="flex shrink-0 items-center gap-1 font-medium underline underline-offset-2"
              >
                Set this class&rsquo;s room <ArrowRight className="size-3.5" />
              </Link>
            </div>
          ))}
        </div>
      )}

      <div className="rounded-lg border border-border bg-card p-4">
        <div className="mb-3 flex items-center justify-between">
          <p className="text-sm font-semibold">Assignments in this batch ({assignments.length})</p>
          <Button size="sm" onClick={handlePreview} disabled={schedulableAssignments.length === 0 || previewing}>
            {previewing && <Loader2 className="size-4 animate-spin" />}
            {preview ? "Regenerate preview" : "Generate preview"}
          </Button>
        </div>
        {schedulableAssignments.length === 0 && (
          <p className="mb-2 text-xs text-amber-700 dark:text-amber-400">
            Set a room for at least one class above before generating.
          </p>
        )}
        <div className="max-h-72 overflow-auto rounded-md border border-border">
          <Table>
            <TableHeader className="sticky top-0 bg-card">
              <TableRow>
                <TableHead>Class</TableHead>
                <TableHead>Room</TableHead>
                <TableHead>Course</TableHead>
                <TableHead>Lecturer</TableHead>
                <TableHead className="text-right">Credit hrs</TableHead>
                <TableHead>Shift override (optional)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {assignments.map((a) => {
                const studyMode = a.studyMode;
                const shiftsForMode = shifts.filter((s) => s.studyMode === studyMode);
                const counts = shiftOverrideCounts[a.assignmentId] ?? {};
                return (
                  <TableRow key={a.assignmentId}>
                    <TableCell>{a.className}</TableCell>
                    <TableCell>
                      {a.classRoomLabel ?? <span className="text-amber-700 dark:text-amber-400">Not set</span>}
                    </TableCell>
                    <TableCell>{a.courseName}</TableCell>
                    <TableCell>{a.lecturerName}</TableCell>
                    <TableCell className="text-right">{a.creditHours}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1.5">
                        {shiftsForMode.map((s) => (
                          <div
                            key={s.id}
                            className="flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-xs"
                          >
                            <button
                              type="button"
                              className="text-muted-foreground hover:text-foreground"
                              onClick={() => adjustOverride(a.assignmentId, s.id, -1)}
                            >
                              −
                            </button>
                            <span>
                              {s.name} ({counts[s.id] ?? 0})
                            </span>
                            <button
                              type="button"
                              className="text-muted-foreground hover:text-foreground"
                              onClick={() => adjustOverride(a.assignmentId, s.id, 1)}
                            >
                              +
                            </button>
                          </div>
                        ))}
                        {shiftsForMode.length === 0 && (
                          <span className="text-xs text-muted-foreground">No shifts for {studyMode ?? "—"}</span>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </div>

      {preview && <PreviewResults preview={preview} />}

      {preview && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/20 p-3">
          <a
            href={`/admin/timetable?classId=${assignments[0]?.classId ?? ""}&semesterId=${group.semesterId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            Review/adjust in the Timetable Builder <ExternalLink className="size-3" />
          </a>
          <Button
            onClick={handleConfirm}
            disabled={
              confirming ||
              preview.scheduledNormally.length + preview.scheduledWithFallback.length === 0
            }
          >
            {confirming && <Loader2 className="size-4 animate-spin" />}
            Confirm this semester
          </Button>
        </div>
      )}
    </div>
  );
}

// The redesigned results view: total summary across every class first,
// then one collapsible section PER CLASS, each with its own three
// clearly-separated counted sub-sections (Scheduled normally / Scheduled
// with spacing fallback / Unscheduled). Replaces the old flat repeated
// list — see the "Fix — grouped, session-labeled results view" changelog
// entry for the bug this was reported against.
function PreviewResults({ preview }: { preview: PreviewBatchResult }) {
  const grouped = useMemo(() => groupGenerationResult(preview), [preview]);
  const { classes, totals } = grouped;

  return (
    <div className="flex flex-col gap-3">
      {preview.comboWarnings.length > 0 && (
        <div className="flex flex-col gap-1 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
          <div className="flex items-center gap-1.5 font-semibold">
            <AlertTriangle className="size-3.5" /> Credit-hour / shift-length mismatches
          </div>
          {preview.comboWarnings.map((w, i) => (
            <p key={i}>
              {w.className} — {w.courseName}: {w.message}
            </p>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/20 p-3">
        <p className="text-sm font-semibold">
          {classes.length} class{classes.length === 1 ? "" : "es"} in this batch:
        </p>
        <Badge variant="published">Scheduled normally ({totals.normal})</Badge>
        <Badge variant="draft">Scheduled with spacing fallback ({totals.fallback})</Badge>
        <Badge variant="destructive">Unscheduled ({totals.unscheduled})</Badge>
      </div>

      <div className="flex flex-col gap-2">
        {classes.map((c) => (
          <ClassResultGroup key={c.classId} classGroup={c} />
        ))}
      </div>
    </div>
  );
}

function ClassResultGroup({ classGroup }: { classGroup: ResultClassGroup }) {
  const normalAssignments = classGroup.assignments
    .map((a) => ({ ...a, sessions: a.sessions.filter((s) => s.status === "normal") }))
    .filter((a) => a.sessions.length > 0);
  const fallbackAssignments = classGroup.assignments
    .map((a) => ({ ...a, sessions: a.sessions.filter((s) => s.status === "fallback") }))
    .filter((a) => a.sessions.length > 0);

  return (
    <details open className="group rounded-lg border border-border bg-card">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 p-3 text-sm font-semibold [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
        {classGroup.className}
        <span className="flex flex-wrap items-center gap-1.5 text-xs font-normal">
          {classGroup.countNormal > 0 && (
            <Badge variant="published">{classGroup.countNormal} normal</Badge>
          )}
          {classGroup.countFallback > 0 && (
            <Badge variant="draft">{classGroup.countFallback} fallback</Badge>
          )}
          {classGroup.countUnscheduled > 0 && (
            <Badge variant="destructive">{classGroup.countUnscheduled} unscheduled</Badge>
          )}
        </span>
      </summary>
      <div className="flex flex-col gap-3 border-t border-border p-3 pt-3">
        <AssignmentSessionSection
          title={`Scheduled normally (${classGroup.countNormal})`}
          tone="published"
          assignments={normalAssignments}
        />
        <AssignmentSessionSection
          title={`Scheduled with spacing fallback (${classGroup.countFallback})`}
          tone="draft"
          assignments={fallbackAssignments}
        />
        <UnscheduledReasonSection classGroup={classGroup} />
      </div>
    </details>
  );
}

function AssignmentSessionSection({
  title,
  tone,
  assignments,
}: {
  title: string;
  tone: "published" | "draft";
  assignments: { assignmentId: string; courseName: string; lecturerName: string; sessions: ResultSessionRow[] }[];
}) {
  if (assignments.length === 0) return null;
  return (
    <div className="rounded-lg border border-border bg-muted/10 p-3">
      <div className="mb-2 flex items-center gap-2">
        <Badge variant={tone}>{title}</Badge>
      </div>
      <div className="flex flex-col gap-2">
        {assignments.map((a) => (
          <div key={a.assignmentId} className="rounded-md border border-border bg-card p-2 text-xs">
            <p className="mb-1 font-medium">
              {a.courseName} — {a.lecturerName}
            </p>
            <div className="flex flex-col gap-1 pl-2">
              {a.sessions.map((s) => (
                <p key={s.sessionNumber} className="text-muted-foreground">
                  {s.sessionCount > 1 && (
                    <span className="font-medium text-foreground">
                      Session {s.sessionNumber} of {s.sessionCount}:{" "}
                    </span>
                  )}
                  {s.day} {s.time}
                  {s.fallbackNote && (
                    <span className="text-amber-700 dark:text-amber-400"> — {s.fallbackNote}</span>
                  )}
                </p>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Unscheduled reasons GROUPED — the same explanation string is shown once,
// not repeated per affected session, per the "deduplicated where the same
// reason applies to a clear group" fix.
function UnscheduledReasonSection({ classGroup }: { classGroup: ResultClassGroup }) {
  if (classGroup.countUnscheduled === 0) return null;
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
      <div className="mb-2 flex items-center gap-2">
        <Badge variant="destructive">
          <XCircle className="size-3" /> Unscheduled ({classGroup.countUnscheduled})
        </Badge>
      </div>
      <div className="flex flex-col gap-2">
        {classGroup.unscheduledReasonGroups.map((rg, i) => (
          <div key={i} className="rounded-md border border-border bg-card p-2 text-xs">
            <p className="mb-1 text-muted-foreground">{rg.reason}</p>
            <ul className="flex flex-col gap-0.5 pl-2">
              {rg.items.map((item) => (
                <li key={`${item.assignmentId}-${item.sessionNumber}`} className="font-medium">
                  {item.courseName} — {item.lecturerName}
                  {item.sessionCount > 1 && ` (Session ${item.sessionNumber} of ${item.sessionCount})`}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
