"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { AlertTriangle, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { WeeklyGrid, type WeeklyGridSlot } from "@/components/timetable/weekly-grid";
import { getActionErrorMessage } from "@/lib/action-error";
import { useUrlTableState } from "@/lib/use-url-table-state";
import type { TimetableConflict } from "@/lib/timetable-conflicts";
import { getValidDaysForStudyMode, DAY_LABELS } from "@/lib/timetable-days";
import { RoomsClient } from "./rooms/rooms-client";
import { CampusesClient } from "./campuses/campuses-client";
import { BuildTimetableClient } from "./build-timetable-client";
import { timetableSlotSchema, type TimetableSlotInput } from "./schema";
import { ALL_SEMESTERS_VALUE } from "./constants";
import type { TimetablePanelData } from "./queries";
import { createTimetableSlot, updateTimetableSlot, deleteTimetableSlot, checkTimetableConflicts } from "./actions";

const ALL_VALUE = "";
const ALL_DAYS: TimetableSlotInput["dayOfWeek"][] = [
  "SUN",
  "MON",
  "TUE",
  "WED",
  "THU",
  "FRI",
  "SAT",
];

type SlotRow = TimetablePanelData["slots"][number];

export function TimetableClient({
  slots,
  assignments,
  rooms,
  campuses,
  semesters,
  classes,
  lecturers,
  activeSemesterId,
  unassigned,
  canManageCampuses,
  canManageRooms,
}: TimetablePanelData & { canManageCampuses: boolean; canManageRooms: boolean }) {
  const router = useRouter();
  const table = useUrlTableState();
  const [, startTransition] = useTransition();
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
  const validDays = getValidDaysForStudyMode(selectedAssignment?.class.studyMode ?? null) ?? ALL_DAYS;

  // If switching assignments makes the currently-picked day invalid for
  // the new class's studyMode, clear it rather than silently submitting
  // a day the picker no longer even shows.
  useEffect(() => {
    if (watched.dayOfWeek && !validDays.includes(watched.dayOfWeek)) {
      form.setValue("dayOfWeek", undefined as never);
    }
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

  function findSlot(id: string) {
    return slots.find((s) => s.id === id) ?? null;
  }

  const gridSlots: WeeklyGridSlot[] = slots.map((s) => ({
    id: s.id,
    dayOfWeek: s.dayOfWeek,
    startTime: s.startTime,
    endTime: s.endTime,
    courseName: s.assignment.course.name,
    className: s.assignment.class.name,
    lecturerName: s.assignment.lecturer.user.fullName,
    roomName: s.room.name,
    studyMode: s.assignment.class.studyMode,
  }));

  const selectedSemesterId = table.getFilter("semesterId");
  const selectedCampusId = table.getFilter("campusId");

  // When a campus filter is active, narrow the Room filter's own options
  // to that campus — a large university may have identically-named rooms
  // across campuses, so this (plus the "name — campus" label everywhere
  // a room is picked) is how the picker disambiguates them.
  const roomsForFilter = selectedCampusId
    ? rooms.filter((r) => r.campusId === selectedCampusId)
    : rooms;

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
        <Tabs defaultValue="build">
          <TabsList>
            <TabsTrigger value="build">Build Timetable</TabsTrigger>
            <TabsTrigger value="grid">Weekly Grid</TabsTrigger>
            <TabsTrigger value="rooms">Rooms</TabsTrigger>
            <TabsTrigger value="campuses">Campuses</TabsTrigger>
          </TabsList>

          <TabsContent value="build" className="pt-4">
            <BuildTimetableClient
              classes={classes}
              assignments={assignments}
              rooms={rooms}
              semesters={semesters}
              activeSemesterId={activeSemesterId}
            />
          </TabsContent>

          <TabsContent value="grid" className="flex flex-col gap-4 pt-4">
            <div className="flex flex-wrap gap-2">
              <div className="w-44">
                <SearchableSelect
                  value={table.getFilter("classId") || ALL_VALUE}
                  onValueChange={(value) => table.setFilter("classId", value)}
                  items={[
                    { value: ALL_VALUE, label: "All classes" },
                    ...classes.map((cls) => ({ value: cls.id, label: cls.name })),
                  ]}
                  placeholder="Class"
                  searchPlaceholder="Search classes…"
                  className="w-full"
                />
              </div>
              <div className="w-44">
                <SearchableSelect
                  value={table.getFilter("lecturerId") || ALL_VALUE}
                  onValueChange={(value) => table.setFilter("lecturerId", value)}
                  items={[
                    { value: ALL_VALUE, label: "All lecturers" },
                    ...lecturers.map((l) => ({ value: l.id, label: l.user.fullName })),
                  ]}
                  placeholder="Lecturer"
                  searchPlaceholder="Search lecturers…"
                  className="w-full"
                />
              </div>
              <div className="w-44">
                <SearchableSelect
                  value={selectedCampusId || ALL_VALUE}
                  onValueChange={(value) => table.setFilter("campusId", value)}
                  items={[
                    { value: ALL_VALUE, label: "All campuses" },
                    ...campuses.map((c) => ({ value: c.id, label: c.name })),
                  ]}
                  placeholder="Campus"
                  searchPlaceholder="Search campuses…"
                  className="w-full"
                />
              </div>
              <div className="w-52">
                <SearchableSelect
                  value={table.getFilter("roomId") || ALL_VALUE}
                  onValueChange={(value) => table.setFilter("roomId", value)}
                  items={[
                    { value: ALL_VALUE, label: "All rooms" },
                    ...roomsForFilter.map((r) => ({
                      value: r.id,
                      label: `${r.name} — ${r.campus.name}`,
                      keywords: [r.campus.name],
                    })),
                  ]}
                  placeholder="Room"
                  searchPlaceholder="Search rooms…"
                  className="w-full"
                />
              </div>
              <div className="w-52">
                <SearchableSelect
                  value={selectedSemesterId || ALL_SEMESTERS_VALUE}
                  onValueChange={(value) => table.setFilter("semesterId", value)}
                  items={[
                    { value: ALL_SEMESTERS_VALUE, label: "All semesters" },
                    ...semesters.map((s) => ({
                      value: s.id,
                      label: `${s.name} (${s.academicYear.name})${s.isActive ? " — active" : ""}`,
                    })),
                  ]}
                  placeholder="Semester"
                  searchPlaceholder="Search semesters…"
                  className="w-full"
                />
              </div>
            </div>

            <WeeklyGrid
              slots={gridSlots}
              onEdit={(gs) => {
                const full = findSlot(gs.id);
                if (full) openEdit(full);
              }}
              onDelete={(gs) => {
                const full = findSlot(gs.id);
                if (full) onDeleteSlot(full);
              }}
            />
          </TabsContent>

          <TabsContent value="rooms" className="pt-4">
            <RoomsClient rooms={rooms} campuses={campuses} canManage={canManageRooms} />
          </TabsContent>

          <TabsContent value="campuses" className="pt-4">
            <CampusesClient campuses={campuses} canManage={canManageCampuses} />
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
                        label: `${a.course.name} — ${a.class.name} (${a.lecturer.user.fullName}, ${a.semester.name})`,
                        keywords: [a.course.name, a.class.name, a.lecturer.user.fullName],
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
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="roomId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Room</FormLabel>
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
