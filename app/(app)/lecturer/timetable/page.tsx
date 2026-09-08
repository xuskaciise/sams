import { redirect } from "next/navigation";
import { CalendarX2 } from "lucide-react";
import { getCurrentUser, getSessionContext } from "@/lib/auth";
import { getMyTimetableForLecturer } from "@/app/(app)/admin/timetable/queries";
import { PageHeader } from "@/components/layout/page-header";
import { WeeklyGrid, type WeeklyGridSlot } from "@/components/timetable/weekly-grid";
import { formatClassLabel } from "@/lib/class-label";

// Lecturer's own read-only weekly schedule — WeeklyGrid(s) with no
// edit/delete handlers, so no per-slot menu (building/managing timetables
// stays Admin/Dean-only). Coexists with the dashboard "Today's Schedule"
// widget (getMyTodayScheduleAsLecturer): this is the full week.
//
// Rendered as TWO separate grids — Fulltime (Sat–Wed) and Parttime
// (Thu–Fri) — never mixed: FT and PT have different valid days/shifts, so
// one combined grid would jam both day sets together. Both sections are
// always shown (with an empty state when a lecturer teaches only one
// mode) so the page reads consistently.
//
// Self-gate on the LECTURER-signature key (defense in depth on top of
// lecturer/layout.tsx): timetable.view.own alone, held by STUDENT too,
// must not reach this lecturer route. Same redirect-self-gate pattern as
// the student /student/timetable page and WorkloadImportPanel.

function EmptySection({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-border bg-card py-12 text-muted-foreground">
      <CalendarX2 className="size-6" />
      <p className="text-sm">{label}</p>
    </div>
  );
}

export default async function LecturerTimetablePage() {
  const ctx = await getSessionContext();
  if (!ctx?.permissions.has("assessment.view.own")) {
    redirect("/");
  }

  const user = await getCurrentUser();
  const slots = await getMyTimetableForLecturer(user!.id);

  const gridSlots: WeeklyGridSlot[] = slots.map((s) => ({
    id: s.id,
    dayOfWeek: s.dayOfWeek,
    startTime: s.startTime,
    endTime: s.endTime,
    courseName: s.assignment.course.name,
    className: formatClassLabel(s.assignment.class),
    lecturerName: s.assignment.lecturer.fullName,
    roomName: s.room.name,
    studyMode: s.assignment.class.studyMode,
  }));

  // Split by the session's class studyMode. WeeklyGrid already narrows
  // its day columns to a single mode's valid days when every slot it's
  // given shares that mode, so each filtered list renders the right week.
  const ftSlots = gridSlots.filter((s) => s.studyMode === "FT");
  const ptSlots = gridSlots.filter((s) => s.studyMode === "PT");
  // Legacy/incomplete classes with no studyMode belong to neither —
  // surfaced in their own section (all 7 days) only when present, so a
  // session is never silently dropped from the page.
  const otherSlots = gridSlots.filter((s) => !s.studyMode);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="My Schedule" description="Your weekly teaching schedule, read-only." />

      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-foreground">Fulltime Schedule</h2>
        {ftSlots.length > 0 ? (
          <WeeklyGrid slots={ftSlots} />
        ) : (
          <EmptySection label="No fulltime sessions" />
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-foreground">Parttime Schedule</h2>
        {ptSlots.length > 0 ? (
          <WeeklyGrid slots={ptSlots} />
        ) : (
          <EmptySection label="No parttime sessions" />
        )}
      </section>

      {otherSlots.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold text-foreground">Other sessions</h2>
          <p className="text-xs text-muted-foreground">
            Sessions for classes with no study mode set yet.
          </p>
          <WeeklyGrid slots={otherSlots} />
        </section>
      )}
    </div>
  );
}
