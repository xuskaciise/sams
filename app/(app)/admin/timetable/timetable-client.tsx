"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { AlertTriangle, ArrowRight, Loader2, Plus } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { PageHeader } from "@/components/layout/page-header";
import { getActionErrorMessage } from "@/lib/action-error";
import type { TimetableConflict } from "@/lib/timetable-conflicts";
import { getValidDaysForStudyMode, restrictDaysToLecturerAvailability, formatDayList, DAY_LABELS } from "@/lib/timetable-days";
import { formatClassLabel } from "@/lib/class-label";
import { ShiftsClient } from "./shifts/shifts-client";
import { BuildTimetableClient } from "./build-timetable-client";
import { NowViewClient } from "./now-view-client";
import { timetableSlotSchema, type TimetableSlotInput } from "./schema";
import type { TimetablePanelData, SlotRow } from "./queries";
import type { NowViewData } from "./panel";
import { createTimetableSlot, updateTimetableSlot, deleteTimetableSlot, checkTimetableConflicts } from "./actions";

const ALL_DAYS: TimetableSlotInput["dayOfWeek"][] = [
  "SUN",
  "MON",
  "TUE",
  "WED",
  "THU",
  "FRI",
  "SAT",
];

export function TimetableClient({
  slots,
  assignments,
  rooms,
  campuses,
  shifts,
  semesters,
  classes,
  lecturers,
  activeSemesterId,
  unassigned,
  canManageShifts,
  nowView,
}: TimetablePanelData & {
  canManageShifts: boolean;
  nowView: NowViewData;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [activeTab, setActiveTab] = useState("now");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<SlotRow | null>(null);
  const [conflicts, setConflicts] = useState<TimetableConflict[]>([]);
  const [checkingConflicts, setCheckingConflicts] = useState(false);

  const form = useForm<TimetableSlotInput>({
    resolver: zodResolver(timetableSlotSchema),
    defaultValues: {
      lecturerCourseAssignmentId: "",
      dayOfWeek: "MON",
      startTime: "",
      endTime: "",
      roomId: "",
      crossPeriodOverride: false,
    },
  });

  const watched = form.watch();

  // Days offered narrow to the selected assignment's class's studyMode
  // (FT: Sat-Wed, PT: Thu-Fri) — days outside the mode aren't offered at
  // all, not just blocked on submit. Falls back to the full week when no
  // assignment is picked yet or its class has no studyMode set.
  const selectedAssignment = assignments.find(
    (a) => a.id === watched.lecturerCourseAssignmentId
  );
  const classValidDays = getValidDaysForStudyMode(selectedAssignment?.class.studyMode ?? null) ?? ALL_DAYS;
  // OPTIONAL hard scheduling constraint (see Lecturer.availableDays) —
  // narrows the class's own valid days down further, on top of the
  // FT/PT restriction above. Empty (the default) never restricts
  // anything, exactly today's behavior.
  const lecturerAvailableDays = selectedAssignment?.lecturer.availableDays ?? [];
  const validDays = restrictDaysToLecturerAvailability(classValidDays, lecturerAvailableDays);
  const lecturerFullyBlocked = lecturerAvailableDays.length > 0 && validDays.length === 0;

  // Shifts are a pure convenience: picking one just fills the (always
  // editable) start/end time fields below — it's never locked, and
  // conflict detection always works off whatever the fields end up
  // holding, shift-derived or hand-typed. Narrowed to the selected
  // assignment's class's studyMode, same as the Day picker; falls back to
  // an empty list (no shifts offered) rather than every shift when no
  // assignment/studyMode is known yet, since an unfiltered mixed-mode
  // list would be actively misleading here. FT is further narrowed to
  // ONLY shifts matching the class's own period (Morning/Afternoon) —
  // same restriction the auto-generate algorithm enforces (see
  // lib/auto-timetable.ts and CLAUDE.md's "Period" business rule); PT is
  // completely unaffected. An FT class with no period assigned yet
  // matches zero shifts here, same as zero shifts existing at all — see
  // classPeriodMissing below for the specific reason shown to the admin.
  const selectedClassStudyMode = selectedAssignment?.class.studyMode ?? null;
  const selectedClassPeriod = selectedAssignment?.class.period ?? null;
  const classPeriodMissing = selectedClassStudyMode === "FT" && !selectedClassPeriod;
  // Manual, per-session, opt-in exception ONLY (see CLAUDE.md's "Period"
  // business rule's "cross-period override" bullet) — the checkbox itself
  // only makes sense for an FT class with a real period set (PT has no
  // period concept; a period-less FT class has classPeriodMissing's own
  // warning instead). Checking it is what widens THIS shift picker to
  // also include the OTHER period's shifts — the default (unchecked)
  // stays exactly the own-period-only restriction.
  const crossPeriodEligible = selectedClassStudyMode === "FT" && !!selectedClassPeriod;
  const shiftsForClass = selectedAssignment
    ? shifts.filter(
        (s) =>
          s.studyMode === selectedClassStudyMode &&
          (selectedClassStudyMode !== "FT" ||
            s.period === selectedClassPeriod ||
            (watched.crossPeriodOverride && crossPeriodEligible && s.period && s.period !== selectedClassPeriod))
      )
    : [];

  // If switching assignments makes the currently-picked day invalid for
  // the new class's studyMode, clear it rather than silently submitting
  // a day the picker no longer even shows.
  useEffect(() => {
    if (watched.dayOfWeek && !validDays.includes(watched.dayOfWeek)) {
      form.setValue("dayOfWeek", undefined as never);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watched.lecturerCourseAssignmentId]);

  // A class normally keeps ONE room for its whole week — prefill the Room
  // field with whichever room its OTHER sessions already mostly use, as
  // soon as a course assignment is picked. Only fires while the field is
  // still empty, so it never clobbers a room already chosen (including one
  // already set when editing an existing slot) — the field stays fully
  // editable either way, this is just a starting point.
  useEffect(() => {
    if (!selectedAssignment || watched.roomId) return;
    const classSlots = slots.filter((s) => s.assignment.classId === selectedAssignment.classId);
    if (classSlots.length === 0) return;
    const counts = new Map<string, number>();
    for (const s of classSlots) counts.set(s.roomId, (counts.get(s.roomId) ?? 0) + 1);
    const established = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    form.setValue("roomId", established, { shouldValidate: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watched.lecturerCourseAssignmentId]);

  // Inline conflict preview — reuses the exact server-side pure function
  // via checkTimetableConflicts, debounced, purely advisory (the real
  // create/update action re-validates and is the actual enforcement
  // boundary).
  useEffect(() => {
    const parsed = timetableSlotSchema.safeParse(watched);
    if (!parsed.success) {
      setConflicts([]);
      return;
    }
    let cancelled = false;
    setCheckingConflicts(true);
    const timer = setTimeout(async () => {
      try {
        const result = await checkTimetableConflicts(parsed.data, editing?.id);
        if (!cancelled) setConflicts(result);
      } catch {
        if (!cancelled) setConflicts([]);
      } finally {
        if (!cancelled) setCheckingConflicts(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    watched.lecturerCourseAssignmentId,
    watched.dayOfWeek,
    watched.startTime,
    watched.endTime,
    watched.roomId,
    editing,
  ]);

  function openCreate() {
    setEditing(null);
    setConflicts([]);
    form.reset({
      lecturerCourseAssignmentId: "",
      dayOfWeek: "MON",
      startTime: "",
      endTime: "",
      roomId: "",
      crossPeriodOverride: false,
    });
    setDialogOpen(true);
  }

  function openEdit(slot: SlotRow) {
    setEditing(slot);
    setConflicts([]);
    form.reset({
      lecturerCourseAssignmentId: slot.lecturerCourseAssignmentId,
      dayOfWeek: slot.dayOfWeek,
      startTime: slot.startTime,
      endTime: slot.endTime,
      roomId: slot.roomId,
      crossPeriodOverride: slot.crossPeriodOverride,
    });
    setDialogOpen(true);
  }

  async function onSubmit(values: TimetableSlotInput) {
    try {
      if (editing) {
        await updateTimetableSlot(editing.id, values);
        toast.success("Timetable slot updated.");
      } else {
        await createTimetableSlot(values);
        toast.success("Timetable slot created.");
      }
      setDialogOpen(false);
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(
        getActionErrorMessage(error, "Something went wrong. Please try again.")
      );
    }
  }

  async function onDeleteSlot(slot: SlotRow) {
    if (!window.confirm("Remove this timetable slot?")) return;
    try {
      await deleteTimetableSlot(slot.id);
      toast.success("Timetable slot removed.");
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not remove this slot."));
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Timetable"
        description="Schedule course, lecturer, day, time, and room per class and semester."
        action={
          <Button onClick={openCreate}>
            <Plus className="size-4" />
            Add slot
          </Button>
        }
      />

      {unassigned ? (
        <p className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
          You have not been assigned to a faculty yet. Contact an administrator.
        </p>
      ) : (
        <Tabs value={activeTab} onValueChange={(value) => value && setActiveTab(value)}>
          <TabsList>
            <TabsTrigger value="now">Timetable</TabsTrigger>
            <TabsTrigger value="build">Build Timetable</TabsTrigger>
            <TabsTrigger value="shifts">Shifts</TabsTrigger>
          </TabsList>

          <TabsContent value="now" className="pt-4">
            <NowViewClient
              nowView={nowView}
              classes={classes}
              lecturers={lecturers}
              rooms={rooms}
              campuses={campuses}
              shifts={shifts}
              semesters={semesters}
              onEdit={openEdit}
              onDelete={onDeleteSlot}
              onGoToShifts={() => setActiveTab("shifts")}
            />
          </TabsContent>

          <TabsContent value="build" className="pt-4">
            <BuildTimetableClient
              classes={classes}
              assignments={assignments}
              rooms={rooms}
              shifts={shifts}
              semesters={semesters}
              activeSemesterId={activeSemesterId}
              onGoToShifts={() => setActiveTab("shifts")}
            />
          </TabsContent>

          <TabsContent value="shifts" className="pt-4">
            <ShiftsClient shifts={shifts} canManage={canManageShifts} />
          </TabsContent>
        </Tabs>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit timetable slot" : "Add timetable slot"}</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4">
              <FormField
                control={form.control}
                name="lecturerCourseAssignmentId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Course assignment</FormLabel>
                    <SearchableSelect
                      value={field.value}
                      onValueChange={field.onChange}
                      items={assignments.map((a) => ({
                        value: a.id,
                        label: `${a.course.name} — ${formatClassLabel(a.class)} (${a.lecturer.fullName}, ${a.semester.name})`,
                        keywords: [a.course.name, a.class.name, a.lecturer.fullName],
                      }))}
                      placeholder="Select a course assignment"
                      searchPlaceholder="Search assignments…"
                      emptyMessage="No course assignments found."
                      className="w-full"
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="dayOfWeek"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Day</FormLabel>
                      <Select
                        value={field.value}
                        onValueChange={field.onChange}
                        disabled={!selectedAssignment}
                      >
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue
                              placeholder={
                                selectedAssignment ? "Select a day" : "Pick a course assignment first"
                              }
                            />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {validDays.map((d) => (
                            <SelectItem key={d} value={d}>
                              {DAY_LABELS[d]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {lecturerAvailableDays.length > 0 && !lecturerFullyBlocked && (
                        <p className="text-xs text-muted-foreground">
                          This lecturer is only available {formatDayList(lecturerAvailableDays)} — days outside
                          that are hidden here.
                        </p>
                      )}
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="roomId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Room{" "}
                        <span className="text-muted-foreground font-normal">
                          (defaults to this class&rsquo;s usual room — still editable)
                        </span>
                      </FormLabel>
                      <SearchableSelect
                        value={field.value}
                        onValueChange={field.onChange}
                        items={rooms.map((r) => ({
                          value: r.id,
                          label: `${r.name} — ${r.campus.name}`,
                          keywords: [r.campus.name],
                        }))}
                        placeholder="Select a room"
                        searchPlaceholder="Search rooms or campuses…"
                        className="w-full"
                      />
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {lecturerFullyBlocked && selectedAssignment && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive">
                  <AlertTriangle className="size-3.5 shrink-0" />
                  <span>
                    This lecturer is only available {formatDayList(lecturerAvailableDays)}, none of which are
                    valid teaching days for this class — no day can be picked. Change their available days in
                    Lecturer Registration first.
                  </span>
                  <Link
                    href="/admin/lecturers"
                    className="flex items-center gap-1 font-medium underline underline-offset-2"
                  >
                    Go to Lecturer Registration <ArrowRight className="size-3.5" />
                  </Link>
                </div>
              )}

              {crossPeriodEligible && (
                <FormField
                  control={form.control}
                  name="crossPeriodOverride"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-start gap-2 space-y-0 rounded-lg border border-violet-500/30 bg-violet-500/5 p-3">
                      <FormControl>
                        <Checkbox
                          checked={field.value}
                          onCheckedChange={(checked) => field.onChange(checked === true)}
                        />
                      </FormControl>
                      <div className="flex flex-col gap-0.5">
                        <FormLabel className="font-normal">Allow cross-period shift for this session</FormLabel>
                        <p className="text-xs text-muted-foreground">
                          Manual exception only — this class is normally restricted to its own period&rsquo;s
                          shifts. Checking this widens the shift picker below to also offer the other
                          period&rsquo;s shifts, and flags this one session as an intentional exception.
                        </p>
                      </div>
                    </FormItem>
                  )}
                />
              )}

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">
                  Use a shift <span className="text-muted-foreground">(optional — pre-fills the times below, still editable)</span>
                </label>
                <SearchableSelect
                  value=""
                  onValueChange={(shiftId) => {
                    const shift = shiftsForClass.find((s) => s.id === shiftId);
                    if (!shift) return;
                    form.setValue("startTime", shift.startTime, { shouldValidate: true });
                    form.setValue("endTime", shift.endTime, { shouldValidate: true });
                  }}
                  items={shiftsForClass.map((s) => ({
                    value: s.id,
                    label: `${s.name} (${s.startTime}–${s.endTime})${
                      s.period && s.period !== selectedClassPeriod ? " — cross-period" : ""
                    }`,
                  }))}
                  placeholder={
                    selectedAssignment ? "No shift — custom time" : "Pick a course assignment first"
                  }
                  searchPlaceholder="Search shifts…"
                  emptyMessage={
                    classPeriodMissing
                      ? "This class has no period (Morning/Afternoon) set yet."
                      : "No shifts for this study mode/period yet."
                  }
                  disabled={!selectedAssignment}
                  className="w-full"
                />
                {classPeriodMissing && selectedAssignment && (
                  <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="size-3.5 shrink-0" />
                    <span>
                      This class has no period (Morning/Afternoon) assigned, so no shifts can be
                      offered — set one in Academic Structure &gt; Classes first.
                    </span>
                    <Link
                      href={`/admin/structure?tab=classes&editClassId=${selectedAssignment.classId}`}
                      className="flex items-center gap-1 font-medium underline underline-offset-2"
                    >
                      Set this class&rsquo;s period <ArrowRight className="size-3.5" />
                    </Link>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="startTime"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Start time</FormLabel>
                      <FormControl>
                        <Input type="time" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="endTime"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>End time</FormLabel>
                      <FormControl>
                        <Input type="time" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {checkingConflicts && (
                <p className="text-xs text-muted-foreground">Checking for conflicts…</p>
              )}
              {conflicts.length > 0 && (
                <div className="flex flex-col gap-1 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                  <div className="flex items-center gap-1.5 font-semibold">
                    <AlertTriangle className="size-3.5" />
                    This slot conflicts with existing bookings
                  </div>
                  {conflicts.map((c, i) => (
                    <p key={i}>{c.message}</p>
                  ))}
                </div>
              )}

              <Button
                type="submit"
                disabled={form.formState.isSubmitting || conflicts.length > 0}
                className="mt-2"
              >
                {form.formState.isSubmitting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : editing ? (
                  "Save changes"
                ) : (
                  "Create slot"
                )}
              </Button>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
