"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { AlertTriangle, Loader2 } from "lucide-react";
import type { Student, StudentGroup, GroupMember } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { getActionErrorMessage } from "@/lib/action-error";
import { applySameMarkToGroup } from "./group-actions";
import { ResultGrid, type GridRow } from "./result-grid";

type AttendanceStatus = "PRESENT" | "ABSENT" | "EXEMPT";
type EntryMode = "same" | "different";
type GroupWithMembers = StudentGroup & {
  members: (GroupMember & { student: Student })[];
};

const ATTENDANCE_ITEMS = [
  { value: "PRESENT", label: "Present" },
  { value: "ABSENT", label: "Absent" },
  { value: "EXEMPT", label: "Exempt" },
];

function existingMarks(group: GroupWithMembers, rowsByStudentId: Map<string, GridRow>) {
  return group.members
    .map((m) => rowsByStudentId.get(m.studentId)?.mark ?? null)
    .filter((m): m is number => m !== null);
}

function hasVariance(marks: number[]) {
  return marks.length > 1 && !marks.every((m) => m === marks[0]);
}

// Results tab for GROUP-mode assessments — replaces the flat per-student
// grid entirely (that grid ignoring group structure was the bug). Each
// group is its own card with a same-mark/different-marks toggle; students
// in no group at all get a separate, clearly-flagged section so they're
// never silently skipped.
export function GroupResultGrid({
  assessmentId,
  assignmentId,
  maximumMarks,
  readOnly,
  groups,
  gridRows,
}: {
  assessmentId: string;
  assignmentId: string;
  maximumMarks: number;
  readOnly: boolean;
  groups: GroupWithMembers[];
  gridRows: GridRow[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const rowsByStudentId = new Map(gridRows.map((r) => [r.studentId, r]));
  const groupedStudentIds = new Set(
    groups.flatMap((g) => g.members.map((m) => m.studentId))
  );
  const ungroupedRows = gridRows.filter((r) => !groupedStudentIds.has(r.studentId));

  const [modeByGroup, setModeByGroup] = useState<Record<string, EntryMode>>(() =>
    Object.fromEntries(
      groups.map((g) => {
        const marks = existingMarks(g, rowsByStudentId);
        return [g.id, hasVariance(marks) ? "different" : "same"];
      })
    )
  );
  const [sameMarkByGroup, setSameMarkByGroup] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      groups.map((g) => {
        const marks = existingMarks(g, rowsByStudentId);
        const uniform = marks.length > 0 && !hasVariance(marks);
        return [g.id, uniform ? String(marks[0]) : ""];
      })
    )
  );
  const [attendanceByGroup, setAttendanceByGroup] = useState<
    Record<string, Record<string, AttendanceStatus>>
  >(() =>
    Object.fromEntries(
      groups.map((g) => [
        g.id,
        Object.fromEntries(
          g.members.map((m) => [
            m.studentId,
            rowsByStudentId.get(m.studentId)?.attendanceStatus ?? "PRESENT",
          ])
        ),
      ])
    )
  );
  const [savingGroup, setSavingGroup] = useState<string | null>(null);

  function requestSwitchToSame(group: GroupWithMembers) {
    const marks = existingMarks(group, rowsByStudentId);
    if (
      hasVariance(marks) &&
      !window.confirm(
        `Switching to "Same mark" will overwrite each member's individual mark with one shared mark when you save. Continue?`
      )
    ) {
      return;
    }
    setModeByGroup((prev) => ({ ...prev, [group.id]: "same" }));
  }

  async function onSaveSameMark(group: GroupWithMembers) {
    const raw = sameMarkByGroup[group.id];
    const mark = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
    if (Number.isNaN(mark)) {
      toast.error("Enter a valid mark first.");
      return;
    }
    if (mark < 0 || mark > maximumMarks) {
      toast.error(`Mark must be between 0 and ${maximumMarks}.`);
      return;
    }
    setSavingGroup(group.id);
    try {
      await applySameMarkToGroup(assessmentId, group.id, {
        mark,
        attendanceByStudentId: attendanceByGroup[group.id] ?? {},
      });
      toast.success(`Mark applied to ${group.name}.`);
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(
        getActionErrorMessage(error, "Something went wrong. Please try again.")
      );
    } finally {
      setSavingGroup(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Groups are shared across this course&apos;s assessments.
        </p>
        <Button
          variant="outline"
          size="sm"
          nativeButton={false}
          render={<Link href={`/lecturer/assignments/${assignmentId}/groups`} />}
        >
          Manage groups
        </Button>
      </div>

      <div className="flex flex-col gap-4">
        {groups.map((group) => {
          const memberRows = group.members
            .map((m) => rowsByStudentId.get(m.studentId))
            .filter((r): r is GridRow => Boolean(r));
          // Once published there's nothing left to "enter" — every group
          // just becomes a correctable per-row table, same as before.
          const mode = modeByGroup[group.id] ?? "same";
          const showGrid = readOnly || mode === "different";

          return (
            <Card key={group.id}>
              <CardHeader className="flex items-center justify-between">
                <CardTitle>{group.name}</CardTitle>
                {!readOnly && (
                  <div className="flex gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant={mode === "same" ? "default" : "outline"}
                      onClick={() => requestSwitchToSame(group)}
                    >
                      Same mark for all
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={mode === "different" ? "default" : "outline"}
                      onClick={() =>
                        setModeByGroup((prev) => ({ ...prev, [group.id]: "different" }))
                      }
                    >
                      Different marks
                    </Button>
                  </div>
                )}
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {memberRows.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No members yet.</p>
                ) : showGrid ? (
                  // mode="INDIVIDUAL" here only suppresses ResultGrid's own
                  // redundant "Group" column — this card's title already
                  // names the group.
                  <ResultGrid
                    assessmentId={assessmentId}
                    maximumMarks={maximumMarks}
                    mode="INDIVIDUAL"
                    readOnly={readOnly}
                    initialRows={memberRows}
                    groupId={group.id}
                  />
                ) : (
                  <div className="flex flex-col gap-2">
                    {group.members.map((member) => (
                      <div
                        key={member.id}
                        className="flex items-center justify-between gap-3 text-sm"
                      >
                        <span>
                          {member.student.fullName}{" "}
                          <span className="text-muted-foreground">
                            ({member.student.studentNo})
                          </span>
                        </span>
                        <Select
                          value={attendanceByGroup[group.id]?.[member.studentId] ?? "PRESENT"}
                          onValueChange={(value) =>
                            setAttendanceByGroup((prev) => ({
                              ...prev,
                              [group.id]: {
                                ...prev[group.id],
                                [member.studentId]: value as AttendanceStatus,
                              },
                            }))
                          }
                          items={ATTENDANCE_ITEMS}
                        >
                          <SelectTrigger size="sm" className="w-28">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {ATTENDANCE_ITEMS.map((item) => (
                              <SelectItem key={item.value} value={item.value}>
                                {item.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
              {!readOnly && mode === "same" && memberRows.length > 0 && (
                <CardFooter>
                  <div className="flex w-full items-end gap-2">
                    <div className="flex-1">
                      <Label className="mb-1 text-xs text-muted-foreground">
                        Mark for members marked Present
                      </Label>
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        max={maximumMarks}
                        value={sameMarkByGroup[group.id] ?? ""}
                        onChange={(e) =>
                          setSameMarkByGroup((prev) => ({
                            ...prev,
                            [group.id]: e.target.value,
                          }))
                        }
                      />
                    </div>
                    <Button
                      disabled={savingGroup === group.id}
                      onClick={() => onSaveSameMark(group)}
                    >
                      {savingGroup === group.id ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        "Save"
                      )}
                    </Button>
                  </div>
                </CardFooter>
              )}
            </Card>
          );
        })}
        {groups.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No groups yet.{" "}
            <Link
              href={`/lecturer/assignments/${assignmentId}/groups`}
              className="underline"
            >
              Create one
            </Link>{" "}
            to start assigning members.
          </p>
        )}
      </div>

      {ungroupedRows.length > 0 && (
        <div className="flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-500/30 dark:bg-amber-500/10">
          <div className="flex items-center gap-2 text-amber-800 dark:text-amber-400">
            <AlertTriangle className="size-4 shrink-0" />
            <p className="text-sm font-semibold">
              {ungroupedRows.length} student
              {ungroupedRows.length === 1 ? "" : "s"} not in any group — grade
              them here or they won&apos;t get a mark for this assessment.
            </p>
          </div>
          <ResultGrid
            assessmentId={assessmentId}
            maximumMarks={maximumMarks}
            mode="INDIVIDUAL"
            readOnly={readOnly}
            initialRows={ungroupedRows}
          />
        </div>
      )}
    </div>
  );
}
