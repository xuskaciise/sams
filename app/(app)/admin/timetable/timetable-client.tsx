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
import { RoomsClient } from "./rooms/rooms-client";
import { timetableSlotSchema, type TimetableSlotInput } from "./schema";
import { ALL_SEMESTERS_VALUE, type TimetablePanelData } from "./queries";
import { createTimetableSlot, updateTimetableSlot, deleteTimetableSlot, checkTimetableConflicts } from "./actions";

const ALL_VALUE = "";
const DAY_OPTIONS = [
  { value: "MON", label: "Monday" },
  { value: "TUE", label: "Tuesday" },
  { value: "WED", label: "Wednesday" },
  { value: "THU", label: "Thursday" },
  { value: "FRI", label: "Friday" },
  { value: "SAT", label: "Saturday" },
] as const;

type SlotRow = TimetablePanelData["slots"][number];

export function TimetableClient({
  slots,
  assignments,
  rooms,
  semesters,
  classes,
  lecturers,
  unassigned,
}: TimetablePanelData) {
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
  }));

  const selectedSemesterId = table.getFilter("semesterId");

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
        <Tabs defaultValue="grid">
          <TabsList>
            <TabsTrigger value="grid">Weekly Grid</TabsTrigger>
            <TabsTrigger value="rooms">Rooms</TabsTrigger>
          </TabsList>

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
                  value={table.getFilter("roomId") || ALL_VALUE}
                  onValueChange={(value) => table.setFilter("roomId", value)}
                  items={[
                    { value: ALL_VALUE, label: "All rooms" },
                    ...rooms.map((r) => ({ value: r.id, label: r.name })),
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
            <RoomsClient rooms={rooms} />
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
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="Select a day" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {DAY_OPTIONS.map((d) => (
                            <SelectItem key={d.value} value={d.value}>
                              {d.label}
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
                        items={rooms.map((r) => ({ value: r.id, label: r.name }))}
                        placeholder="Select a room"
                        searchPlaceholder="Search rooms…"
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
