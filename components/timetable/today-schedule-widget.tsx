"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useVisibleInterval } from "@/lib/use-visible-interval";
import { DAY_LABELS } from "@/lib/timetable-days";
import type { TodaySchedule } from "@/lib/timetable-now";

// "Today's Schedule" — Lecturer & Student dashboards. Shows ALL of today's
// sessions in chronological (start-time = correct shift) order:
//   - ended sessions stay in the list, faded, with an "Ended" badge
//   - the in-progress session gets the green "Now" highlight
//   - upcoming sessions render plainly
// Auto-refreshes every 60s (paused while the tab is hidden) via the bound
// `refresh` server action, so NOW/Ended flip live as the day progresses —
// no page reload.
export function TodayScheduleWidget({
  initial,
  refresh,
  emptyLabel,
}: {
  initial: TodaySchedule;
  refresh: () => Promise<TodaySchedule>;
  emptyLabel: string;
}) {
  const [data, setData] = useState<TodaySchedule>(initial);

  useVisibleInterval(() => {
    void (async () => {
      try {
        setData(await refresh());
      } catch {
        /* keep the last-good data on a transient failure */
      }
    })();
  }, 60_000);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-semibold">Today&rsquo;s Schedule</p>
        <p className="text-xs text-muted-foreground">
          {DAY_LABELS[data.day]} · as of {data.time} · updates every 60s
        </p>
      </div>
      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead className="w-28">Time</TableHead>
              <TableHead>Course</TableHead>
              <TableHead>Class</TableHead>
              <TableHead>Room</TableHead>
              <TableHead className="w-20" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.map((s, i) => (
              <TableRow
                key={s.id}
                className={[
                  i % 2 === 1 ? "bg-muted/30" : "",
                  s.state === "ended" ? "opacity-55" : "",
                  s.state === "in_progress" ? "bg-green-500/5" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <TableCell className="font-medium tabular-nums">
                  {s.startTime}–{s.endTime}
                </TableCell>
                <TableCell>{s.courseName}</TableCell>
                <TableCell className="text-muted-foreground">{s.className}</TableCell>
                <TableCell className="text-muted-foreground">{s.roomLabel || "—"}</TableCell>
                <TableCell>
                  {s.state === "in_progress" && <Badge variant="published">Now</Badge>}
                  {s.state === "ended" && <Badge variant="outline">Ended</Badge>}
                </TableCell>
              </TableRow>
            ))}
            {data.items.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground">
                  {emptyLabel}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
