"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { StudyMode } from "@prisma/client";
import { toast } from "sonner";
import { AlertTriangle, ArrowRight, CheckCircle2, Loader2, MapPin, Maximize, Minimize } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { getActionErrorMessage } from "@/lib/action-error";
import {
  classifySemesterNumbersByEligibility,
  describeIneligibleLevels,
  checkBatchFeasibility,
  buildShiftsByStudyMode,
  type AssignmentToSchedule,
} from "@/lib/auto-timetable";
import type { LecturerAvailabilityDayRule } from "@/lib/timetable-days";
import type { PreviewAssignmentMeta, CommitSession } from "@/lib/auto-timetable-preview-state";
import type { CreatedAssignmentSummary } from "../workload-import/actions";
import type { GeneratorShiftOption, GeneratorRoomOption } from "../workload-import/generator-data";
import {
  previewAutoTimetableBatch,
  confirmAutoTimetableBatch,
  saveLecturerAvailableDaysForGeneration,
  type PreviewBatchResult,
} from "./actions";
import type { LecturerAvailabilityUpdateInput } from "./schema";
import { LecturerAvailabilityStep, type LecturerAvailabilityRow } from "./lecturer-availability-step";
import { FeasibilityWarningStep } from "./feasibility-warning-step";
import { MultiClassOverview, type OverviewClassMeta } from "./multi-class-overview";

const PERIOD_LABELS: Record<"MORNING" | "AFTERNOON", string> = {
  MORNING: "Morning",
  AFTERNOON: "Afternoon",
};

interface SemesterGroup {
  semesterId: string;
  semesterLabel: string;
  levels: number[]; // ascending, eligible Class.currentSemesterNumber values, present in this batch
  assignmentsByLevel: Map<number, CreatedAssignmentSummary[]>;
  ineligibleLevels: number[]; // present but the wrong parity for the currently active academic semester
  ineligibleAssignments: CreatedAssignmentSummary[]; // informational only — never auto-generated this cycle
}

interface LevelOption {
  key: string; // `${semesterId}:${level}`
  semesterId: string;
  semesterLabel: string;
  level: number;
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
  rooms: GeneratorRoomOption[];
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
  rooms,
  activeAcademicSemesterNumber,
  onClose,
}: Props) {
  const groups = useMemo(
    () => buildGroups(createdAssignments, activeAcademicSemesterNumber),
    [createdAssignments, activeAcademicSemesterNumber]
  );

  // Flattened across every real Semester group — the "Semester filter"
  // (point 1 of the redesign): a single dropdown listing every eligible
  // (semester, level) pair, freely selectable rather than a forced
  // one-at-a-time stepper. A level already confirmed this session stays
  // selectable too, just rendered as a simple read-only confirmation
  // instead of the editable overview (see the confirmed branch below) —
  // re-previewing an already-confirmed level would try to reschedule
  // assignments that already have real TimetableSlots, which is never
  // correct.
  const levelOptions = useMemo<LevelOption[]>(
    () => groups.flatMap((g) => g.levels.map((level) => ({ key: `${g.semesterId}:${level}`, semesterId: g.semesterId, semesterLabel: g.semesterLabel, level }))),
    [groups]
  );

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [shiftOverrideCounts, setShiftOverrideCounts] = useState<Record<string, Record<string, number>>>({});
  const [preview, setPreview] = useState<PreviewBatchResult | null>(null);
  const [previewVersion, setPreviewVersion] = useState(0);
  const [previewing, setPreviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmedLevels, setConfirmedLevels] = useState<Set<string>>(new Set());
  // Independent of the semester filter/level selection and of any
  // individual class's own fullscreen review (ClassFullscreenModal) — this
  // only controls the multi-class OVERVIEW grid's own layout width. Lives
  // here (not inside MultiClassOverview) so it survives that component
  // being remounted on a fresh preview (regenerate / switching levels),
  // matching the "remember during the session" requirement.
  const [overviewFullWidth, setOverviewFullWidth] = useState(false);
  // Per-level "Lecturer availability" step gate — see
  // lecturer-availability-step.tsx. Once a level's key is in this set, the
  // step is skipped for the rest of THIS session; switching to a level not
  // yet visited (or explicitly re-opening via "Edit lecturer availability"
  // below) shows it again, since availability can change semester to
  // semester and different levels can involve different lecturers.
  const [availabilityConfirmedKeys, setAvailabilityConfirmedKeys] = useState<Set<string>>(new Set());
  // Local overrides layered on top of `createdAssignments`' own
  // (page-load-time) lecturerAvailability — so re-opening "Edit lecturer
  // availability" for a level later in the SAME session pre-fills with
  // what was just saved a moment ago, not the stale original prop value
  // (createdAssignments itself is never refetched mid-session).
  const [savedAvailabilityByLecturer, setSavedAvailabilityByLecturer] = useState<Map<string, LecturerAvailabilityDayRule[]>>(
    new Map()
  );
  // Per-level "Feasibility check" step gate — mirrors
  // availabilityConfirmedKeys exactly (see below). Once a level's key is
  // here, the step is skipped for the rest of THIS session UNLESS
  // "Edit lecturer availability" is used again for that level (which
  // clears it, since the numbers this step is based on may have just
  // changed).
  const [feasibilityBypassedKeys, setFeasibilityBypassedKeys] = useState<Set<string>>(new Set());

  const effectiveKey = selectedKey ?? levelOptions[0]?.key ?? null;
  const selectedOption = levelOptions.find((o) => o.key === effectiveKey) ?? null;
  const group = groups.find((g) => g.semesterId === selectedOption?.semesterId);
  const level = selectedOption?.level;
  const levelConfirmed = effectiveKey ? confirmedLevels.has(effectiveKey) : false;

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
  // Same "report upfront, exclude, never guess" treatment as room — an FT
  // class with no period (Morning/Afternoon) assigned yet blocks
  // generating for that class specifically. PT is unaffected (no period
  // concept at all, so PT classes never appear here).
  const classesWithoutPeriod = useMemo(() => {
    const seen = new Map<string, string>();
    for (const a of assignments) {
      if (a.studyMode === "FT" && !a.classPeriod) seen.set(a.classId, a.className);
    }
    return [...seen.entries()].map(([classId, className]) => ({ classId, className }));
  }, [assignments]);
  const schedulableAssignments = useMemo(
    () => assignments.filter((a) => a.classRoomId && (a.studyMode !== "FT" || a.classPeriod)),
    [assignments]
  );

  const classMetaById = useMemo(() => {
    const m = new Map<string, OverviewClassMeta>();
    for (const a of schedulableAssignments) {
      if (!m.has(a.classId)) m.set(a.classId, { className: a.className, studyMode: a.studyMode, period: a.classPeriod });
    }
    return m;
  }, [schedulableAssignments]);

  const assignmentMetaById = useMemo(() => {
    const m = new Map<string, PreviewAssignmentMeta>();
    for (const a of schedulableAssignments) {
      if (!a.classRoomId || !a.classRoomLabel) continue; // already excluded above — defensive only
      m.set(a.assignmentId, {
        assignmentId: a.assignmentId,
        classId: a.classId,
        className: a.className,
        courseName: a.courseName,
        lecturerId: a.lecturerId,
        lecturerName: a.lecturerName,
        // Same "prefer what was just saved this session" preference as
        // distinctLecturers below — matters for a chip scheduled via drag
        // after the availability step already ran this session.
        lecturerAvailability: savedAvailabilityByLecturer.get(a.lecturerId) ?? a.lecturerAvailability,
        roomId: a.classRoomId,
        roomLabel: a.classRoomLabel,
      });
    }
    return m;
  }, [schedulableAssignments, savedAvailabilityByLecturer]);

  const roomOptions = useMemo(
    () => rooms.map((r) => ({ value: r.id, label: `${r.name} — ${r.campus.name}`, keywords: [r.campus.name] })),
    [rooms]
  );

  // Distinct lecturers among THIS level's schedulable assignments, for the
  // "Lecturer availability" step — pre-filled from whatever
  // lecturerAvailability each already carries (the DB value as of when
  // `createdAssignments` was fetched, i.e. from a prior generation run, if
  // any). A class excluded for missing room/period contributes no
  // lecturers here, matching "nothing to configure if nothing can be
  // scheduled anyway." Each lecturer's shiftOptions is scoped to their own
  // FT/PT shift set — the union of studyModes among their OWN assignments
  // in this batch (a lecturer teaching both FT and PT this batch sees
  // both catalogs; one teaching only FT never sees PT shifts at all).
  const distinctLecturers = useMemo<LecturerAvailabilityRow[]>(() => {
    const byLecturer = new Map<
      string,
      { lecturerId: string; lecturerName: string; lecturerAvailability: LecturerAvailabilityDayRule[]; studyModes: Set<StudyMode> }
    >();
    for (const a of schedulableAssignments) {
      const entry = byLecturer.get(a.lecturerId) ?? {
        lecturerId: a.lecturerId,
        lecturerName: a.lecturerName,
        lecturerAvailability: a.lecturerAvailability,
        studyModes: new Set<StudyMode>(),
      };
      if (a.studyMode) entry.studyModes.add(a.studyMode);
      byLecturer.set(a.lecturerId, entry);
    }
    return [...byLecturer.values()]
      .map((l) => ({
        lecturerId: l.lecturerId,
        lecturerName: l.lecturerName,
        // Prefer whatever was just saved THIS session (e.g. re-opening
        // "Edit lecturer availability") over the page-load-time prop
        // value, which never refetches mid-session.
        availability: savedAvailabilityByLecturer.get(l.lecturerId) ?? l.lecturerAvailability,
        shiftOptions: shifts.filter((s) => l.studyModes.has(s.studyMode)),
      }))
      .sort((a, b) => a.lecturerName.localeCompare(b.lecturerName));
  }, [schedulableAssignments, savedAvailabilityByLecturer, shifts]);

  const needsAvailabilityStep =
    !!effectiveKey && !levelConfirmed && schedulableAssignments.length > 0 && !availabilityConfirmedKeys.has(effectiveKey);

  const shiftsByStudyMode = useMemo(() => buildShiftsByStudyMode(shifts), [shifts]);

  // The exact same shape the real previewAutoTimetableBatch request
  // ultimately resolves server-side (see loadScopedAssignments in
  // actions.ts) — built here, client-side, purely so
  // checkBatchFeasibility can run against data already loaded, with no
  // extra round trip. Includes whatever shift overrides are currently
  // dialed in (adjustOverride) and whatever availability was just saved
  // this session, so the numbers shown always match what Generate preview
  // would actually try.
  const assignmentsForFeasibility = useMemo<AssignmentToSchedule[]>(
    () =>
      schedulableAssignments
        .filter((a) => a.classRoomId && a.classRoomLabel)
        .map((a) => {
          const counts = shiftOverrideCounts[a.assignmentId];
          const shiftOverrideIds = counts
            ? Object.entries(counts).flatMap(([shiftId, count]) => Array(count).fill(shiftId) as string[])
            : undefined;
          return {
            assignmentId: a.assignmentId,
            classId: a.classId,
            className: a.className,
            studyMode: a.studyMode,
            period: a.classPeriod,
            lecturerId: a.lecturerId,
            lecturerName: a.lecturerName,
            lecturerAvailability: savedAvailabilityByLecturer.get(a.lecturerId) ?? a.lecturerAvailability,
            courseId: a.assignmentId, // no separate courseId on this summary shape — unused by checkBatchFeasibility
            courseName: a.courseName,
            creditHours: a.creditHours,
            mainRoomId: a.classRoomId as string,
            mainRoomName: a.classRoomLabel as string,
            shiftOverrideIds: shiftOverrideIds && shiftOverrideIds.length > 0 ? shiftOverrideIds : undefined,
          };
        }),
    [schedulableAssignments, savedAvailabilityByLecturer, shiftOverrideCounts]
  );

  const feasibilityChecks = useMemo(
    () => checkBatchFeasibility(assignmentsForFeasibility, shiftsByStudyMode),
    [assignmentsForFeasibility, shiftsByStudyMode]
  );
  const infeasibleLecturers = useMemo(() => feasibilityChecks.filter((c) => !c.feasible), [feasibilityChecks]);

  const needsFeasibilityStep =
    !!effectiveKey &&
    !levelConfirmed &&
    !needsAvailabilityStep &&
    infeasibleLecturers.length > 0 &&
    !feasibilityBypassedKeys.has(effectiveKey);

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
      setPreviewVersion((v) => v + 1);
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not generate a preview for this semester."));
    } finally {
      setPreviewing(false);
    }
  }

  // Auto-generate a preview the moment the semester filter lands on a
  // fresh (not-yet-confirmed) level — this is what makes picking the
  // filter alone show every class's mini-grid card, with no separate
  // "Generate preview" click required (point 1 of the redesign). The
  // manual "Regenerate preview" button below still exists for after
  // tweaking a shift override.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the stale preview for the newly-selected level, same pattern as build-timetable-client.tsx's setLoadingSlots
    setPreview(null);
    if (!effectiveKey || levelConfirmed) return;
    // Wait for the "Lecturer availability" step to be confirmed for this
    // level first — handleAvailabilityContinue calls handlePreview()
    // directly once it's done, so the preview still ends up fetched
    // exactly once, just after the step instead of racing it. Likewise
    // wait for the "Feasibility check" step (if it's showing) — its own
    // "Continue anyway" handler calls handlePreview() directly, same
    // pattern.
    if (needsAvailabilityStep || needsFeasibilityStep) return;
    void handlePreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally re-runs only on level change, not on every shiftOverrideCounts/availability edit; handleAvailabilityContinue and the feasibility step's "Continue anyway" each call handlePreview() directly once their own gate clears, so this effect deliberately does NOT also re-fire from needsAvailabilityStep/needsFeasibilityStep flipping (that would double-fetch)
  }, [effectiveKey]);

  // Saves every lecturer's chosen availability for THIS level's batch
  // (overwriting whatever was set for a previous run — availability is
  // re-entered fresh every generation cycle, see CLAUDE.md's "Lecturer
  // availableDays" business rule), then proceeds straight to the preview
  // the gated effect above deliberately skipped. The save payload only
  // carries shift IDS (see LecturerAvailabilityUpdateInput) — resolved
  // back into full LecturerAvailabilityShiftRef entries (name/studyMode/
  // period) here, from the already-loaded `shifts` catalog, before
  // stashing into savedAvailabilityByLecturer, since that map feeds both
  // this step's own future pre-fill AND assignmentMetaById's greying data.
  async function handleAvailabilityContinue(updates: LecturerAvailabilityUpdateInput[]) {
    if (!effectiveKey) return;
    try {
      await saveLecturerAvailableDaysForGeneration(updates);
      setSavedAvailabilityByLecturer((prev) => {
        const next = new Map(prev);
        for (const u of updates) {
          next.set(
            u.lecturerId,
            u.availability.map((d) => ({
              dayOfWeek: d.dayOfWeek,
              shifts: d.shiftIds
                .map((id) => shifts.find((s) => s.id === id))
                .filter((s): s is GeneratorShiftOption => !!s)
                .map((s) => ({ id: s.id, name: s.name, studyMode: s.studyMode, period: s.period })),
            }))
          );
        }
        return next;
      });
      setAvailabilityConfirmedKeys((prev) => new Set(prev).add(effectiveKey));
      // A freshly-saved availability set can turn a previously-fine
      // workload infeasible (or vice versa) — always let the Feasibility
      // check step re-evaluate rather than trusting a stale bypass from
      // before this edit.
      setFeasibilityBypassedKeys((prev) => {
        if (!prev.has(effectiveKey)) return prev;
        const next = new Set(prev);
        next.delete(effectiveKey);
        return next;
      });
      void handlePreview();
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not save lecturer availability."));
    }
  }

  // "Continue anyway" on the Feasibility check step — an admin/dean who's
  // already decided to accept the overload (or knows generation will just
  // leave some of that lecturer's sessions Unscheduled) proceeds straight
  // to the preview, same explicit-call-after-gate-clears pattern as
  // handleAvailabilityContinue above.
  function handleContinueFeasibilityAnyway() {
    if (!effectiveKey) return;
    setFeasibilityBypassedKeys((prev) => new Set(prev).add(effectiveKey));
    void handlePreview();
  }

  // Re-opens the "Lecturer availability" step from within the Feasibility
  // check step itself, so fixing the root cause (adding more days/shifts)
  // is one click away rather than requiring the admin to hunt for the
  // separate "Edit lecturer availability" link below.
  function handleEditAvailabilityFromFeasibility() {
    if (!effectiveKey) return;
    setAvailabilityConfirmedKeys((prev) => {
      const next = new Set(prev);
      next.delete(effectiveKey);
      return next;
    });
    setPreview(null);
  }

  async function handleBuildAll(sessions: CommitSession[]) {
    if (!group || level === undefined || !effectiveKey) return;
    if (sessions.length === 0) {
      toast.error("Nothing to build — every class in this batch is currently unscheduled.");
      return;
    }
    setConfirming(true);
    try {
      const result = await confirmAutoTimetableBatch({ semesterId: group.semesterId, semesterNumber: level, sessions });
      toast.success(
        `Semester level ${level}: ${result.created} session${result.created === 1 ? "" : "s"} added to the timetable.` +
          (result.skippedDueToRaceConflict > 0
            ? ` ${result.skippedDueToRaceConflict} could not be confirmed (a conflict appeared since the preview) — check the Timetable page.`
            : "")
      );
      setConfirmedLevels((prev) => new Set(prev).add(effectiveKey));
      setPreview(null);
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

  if (levelOptions.length === 0) {
    // Nothing eligible right now — but that could genuinely be because
    // every present class level is the WRONG parity for the currently
    // active academic semester (not because there's simply nothing here).
    // Report that explicitly instead of a generic "nothing to schedule."
    const allIneligibleLevels = [...new Set(groups.flatMap((g) => g.ineligibleLevels))].sort((a, b) => a - b);
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

  const allConfirmed = levelOptions.every((o) => confirmedLevels.has(o.key));
  const allIneligibleAcrossGroups = [...new Set(groups.flatMap((g) => g.ineligibleLevels))].sort((a, b) => a - b);
  const totalIneligibleAssignments = groups.reduce((sum, g) => sum + g.ineligibleAssignments.length, 0);
  const ineligibleMessage = describeIneligibleLevels(allIneligibleAcrossGroups, activeAcademicSemesterNumber);

  if (allConfirmed) {
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
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
        <div className="flex-1 text-sm">
          <p className="mb-1 font-semibold">Semester filter</p>
          <p className="text-muted-foreground">
            Pick a semester level to see every class in that batch at once. Levels already confirmed
            are marked below.
          </p>
        </div>
        <div className="w-full sm:w-72">
          <Select value={effectiveKey} onValueChange={(value) => value && setSelectedKey(value)}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select a semester level" />
            </SelectTrigger>
            <SelectContent>
              {levelOptions.map((opt) => (
                <SelectItem key={opt.key} value={opt.key}>
                  {opt.semesterLabel} — Level {opt.level}
                  {confirmedLevels.has(opt.key) ? " (confirmed)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {/* Toggles the multi-class overview grid ONLY (see
            MultiClassOverview's own fullWidth prop) — a separate control
            and a deliberately different icon from each mini card's own
            per-class expand-to-fullscreen button, so the two never read as
            the same action. */}
        <Button
          type="button"
          variant={overviewFullWidth ? "default" : "outline"}
          size="icon"
          aria-pressed={overviewFullWidth}
          onClick={() => setOverviewFullWidth((v) => !v)}
          title={overviewFullWidth ? "Exit full width" : "Full width"}
        >
          {overviewFullWidth ? <Minimize className="size-4" /> : <Maximize className="size-4" />}
          <span className="sr-only">{overviewFullWidth ? "Exit full width" : "Full width"}</span>
        </Button>
      </div>

      {ineligibleMessage && totalIneligibleAssignments > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <p>
            {totalIneligibleAssignments} assignment(s) are not eligible this cycle. {ineligibleMessage}
          </p>
        </div>
      )}

      {levelConfirmed ? (
        <div className="flex flex-col items-start gap-2 rounded-lg border border-border bg-card p-6">
          <Badge variant="published">
            <CheckCircle2 className="size-3" /> Confirmed
          </Badge>
          <p className="text-sm text-muted-foreground">
            {selectedOption?.semesterLabel} — Semester level {selectedOption?.level} has already been
            confirmed. Pick a different level above, or review/adjust what was built on the Timetable page.
          </p>
        </div>
      ) : needsAvailabilityStep ? (
        <LecturerAvailabilityStep
          key={effectiveKey}
          lecturers={distinctLecturers}
          onContinue={handleAvailabilityContinue}
        />
      ) : needsFeasibilityStep ? (
        <FeasibilityWarningStep
          key={effectiveKey}
          infeasibleLecturers={infeasibleLecturers}
          onContinueAnyway={handleContinueFeasibilityAnyway}
          onEditAvailability={handleEditAvailabilityFromFeasibility}
        />
      ) : (
        <>
          {effectiveKey && distinctLecturers.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setAvailabilityConfirmedKeys((prev) => {
                  const next = new Set(prev);
                  next.delete(effectiveKey);
                  return next;
                });
                setFeasibilityBypassedKeys((prev) => {
                  if (!prev.has(effectiveKey)) return prev;
                  const next = new Set(prev);
                  next.delete(effectiveKey);
                  return next;
                });
                setPreview(null);
              }}
              className="self-start text-xs font-medium text-primary hover:underline"
            >
              Edit lecturer availability for this level
            </button>
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

          {classesWithoutPeriod.length > 0 && (
            <div className="flex flex-col gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
              <div className="flex items-center gap-1.5 font-semibold">
                <AlertTriangle className="size-3.5" /> {classesWithoutPeriod.length} class(es) have no period
                (Morning/Afternoon) assigned
              </div>
              {classesWithoutPeriod.map((c) => (
                <div key={c.classId} className="flex items-center justify-between gap-2">
                  <span>{c.className} — this class has no period assigned.</span>
                  <Link
                    href={`/admin/structure?tab=classes&editClassId=${c.classId}`}
                    className="flex shrink-0 items-center gap-1 font-medium underline underline-offset-2"
                  >
                    Set this class&rsquo;s period <ArrowRight className="size-3.5" />
                  </Link>
                </div>
              ))}
            </div>
          )}

          <div className="rounded-lg border border-border bg-card p-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-semibold">Assignments in this batch ({assignments.length})</p>
              <Button size="sm" variant="outline" onClick={handlePreview} disabled={schedulableAssignments.length === 0 || previewing}>
                {previewing && <Loader2 className="size-4 animate-spin" />}
                Regenerate preview
              </Button>
            </div>
            {schedulableAssignments.length === 0 && (
              <p className="mb-2 text-xs text-amber-700 dark:text-amber-400">
                Set a room{classesWithoutPeriod.length > 0 ? " and period" : ""} for at least one class above
                before generating.
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
                    // FT-only restriction: the override picker must never
                    // offer a shift from the wrong period (a Morning-period
                    // class only ever sees Subax shifts here, never Galab).
                    // PT is unaffected — every PT shift stays offered.
                    const shiftsForMode = shifts.filter(
                      (s) => s.studyMode === studyMode && (studyMode !== "FT" || s.period === a.classPeriod)
                    );
                    const counts = shiftOverrideCounts[a.assignmentId] ?? {};
                    return (
                      <TableRow key={a.assignmentId}>
                        <TableCell>
                          {a.className}
                          {a.studyMode === "FT" && (
                            <span className="ml-1.5 text-xs text-muted-foreground">
                              ({a.classPeriod ? PERIOD_LABELS[a.classPeriod] : "no period set"})
                            </span>
                          )}
                        </TableCell>
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

          {previewing && !preview && (
            <div className="flex items-center justify-center gap-2 rounded-lg border border-border bg-muted/20 p-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Searching for the best schedule for every class at this level — this may take a few
              seconds…
            </div>
          )}

          {preview && (
            <>
              {preview.backtrackingStats.attempted > 0 && (
                <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
                  <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-green-600" />
                  <p>
                    Backtracking search placed{" "}
                    <span className="font-medium text-foreground">
                      {preview.backtrackingStats.resolved} of {preview.backtrackingStats.attempted}
                    </span>{" "}
                    session(s) that a simple pass would have left Unscheduled, by relocating other
                    already-placed sessions where needed (searched for {preview.backtrackingStats.elapsedMs}
                    ms{preview.backtrackingStats.timedOut ? " — stopped early, time budget reached" : ""}).
                  </p>
                </div>
              )}

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

              <MultiClassOverview
                key={`${effectiveKey}:${previewVersion}`}
                preview={preview}
                classMetaById={classMetaById}
                assignmentMetaById={assignmentMetaById}
                shifts={shifts}
                roomOptions={roomOptions}
                onBuildAll={handleBuildAll}
                building={confirming}
                fullWidth={overviewFullWidth}
                semesterLabel={group?.semesterLabel ?? ""}
                level={level ?? 0}
              />

              <a
                href={`/admin/timetable?classId=${assignments[0]?.classId ?? ""}&semesterId=${group?.semesterId ?? ""}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs font-medium text-primary hover:underline"
              >
                Or review/adjust in the Timetable Builder instead →
              </a>
            </>
          )}
        </>
      )}
    </div>
  );
}
