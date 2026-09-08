"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, ArrowRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { getSchedulingErrorMessage } from "@/lib/action-error";
import {
  previewRoomReassignment,
  applyRoomReassignment,
  type RoomReassignmentPreview,
} from "./actions";

interface ClassRow {
  id: string;
  name: string;
  programId: string;
  programName: string;
  currentSemesterNumber: number | null;
  roomId: string;
  roomLabel: string;
  campusId: string;
  campusName: string;
}

interface RoomOption {
  id: string;
  label: string;
  campusName: string;
}

const ALL = "all";
const SEMESTER_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8];

export function RoomReassignmentClient({
  classes,
  rooms,
}: {
  classes: ClassRow[];
  rooms: RoomOption[];
}) {
  const router = useRouter();
  // classId -> chosen new roomId. Only entries that DIFFER from the
  // class's current room count as changes. Keyed by classId so a change
  // survives the row being filtered out of view (the chain case).
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [programFilter, setProgramFilter] = useState(ALL);
  const [levelFilter, setLevelFilter] = useState(ALL);
  const [campusFilter, setCampusFilter] = useState(ALL);

  const [preview, setPreview] = useState<RoomReassignmentPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [applying, setApplying] = useState(false);

  const programs = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of classes) m.set(c.programId, c.programName);
    return [...m.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [classes]);

  const campuses = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of classes) m.set(c.campusId, c.campusName);
    return [...m.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [classes]);

  const visible = useMemo(
    () =>
      classes.filter(
        (c) =>
          (programFilter === ALL || c.programId === programFilter) &&
          (levelFilter === ALL ||
            String(c.currentSemesterNumber ?? "") === levelFilter) &&
          (campusFilter === ALL || c.campusId === campusFilter)
      ),
    [classes, programFilter, levelFilter, campusFilter]
  );

  const changedRows = useMemo(
    () =>
      Object.entries(picks)
        .filter(([classId, newRoomId]) => {
          const cls = classes.find((c) => c.id === classId);
          return !!cls && !!newRoomId && newRoomId !== cls.roomId;
        })
        .map(([classId, newRoomId]) => ({ classId, newRoomId })),
    [picks, classes]
  );

  function newRoomValue(c: ClassRow) {
    return picks[c.id] ?? c.roomId;
  }

  function setNewRoom(classId: string, roomId: string) {
    setPicks((p) => ({ ...p, [classId]: roomId }));
  }

  function resetAll() {
    setPicks({});
    setPreview(null);
  }

  async function openReview() {
    if (changedRows.length === 0) return;
    setLoadingPreview(true);
    try {
      setPreview(await previewRoomReassignment({ rows: changedRows }));
    } catch (error) {
      toast.error(
        getSchedulingErrorMessage(error, "Could not build the reassignment plan.")
      );
    } finally {
      setLoadingPreview(false);
    }
  }

  async function apply() {
    setApplying(true);
    try {
      const result = await applyRoomReassignment({ rows: changedRows });
      toast.success(
        `Reassigned ${result.applied} class${result.applied === 1 ? "" : "es"} — ${result.totalMovedSessions} session${result.totalMovedSessions === 1 ? "" : "s"} moved.`
      );
      resetAll();
      router.refresh();
    } catch (error) {
      toast.error(
        getSchedulingErrorMessage(error, "Could not apply the reassignment.")
      );
    } finally {
      setApplying(false);
    }
  }

  const roomItems = rooms.map((r) => ({
    value: r.id,
    label: r.label,
    keywords: [r.campusName],
  }));
  const plan = preview?.plan ?? null;
  const blocked = !!plan && plan.conflicts.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-52">
          <SearchableSelect
            value={programFilter === ALL ? "" : programFilter}
            onValueChange={(v) => setProgramFilter(v || ALL)}
            items={[
              { value: "", label: "All programs" },
              ...programs.map((p) => ({ value: p.id, label: p.name })),
            ]}
            placeholder="Program"
            searchPlaceholder="Search programs…"
            className="w-full"
          />
        </div>
        <div className="w-44">
          <Select value={levelFilter} onValueChange={(v) => setLevelFilter(v || ALL)}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Semester level" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All levels</SelectItem>
              {SEMESTER_NUMBERS.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  Semester {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-44">
          <SearchableSelect
            value={campusFilter === ALL ? "" : campusFilter}
            onValueChange={(v) => setCampusFilter(v || ALL)}
            items={[
              { value: "", label: "All campuses" },
              ...campuses.map((c) => ({ value: c.id, label: c.name })),
            ]}
            placeholder="Campus"
            searchPlaceholder="Search campuses…"
            className="w-full"
          />
        </div>
        {changedRows.length > 0 && (
          <Button variant="ghost" size="sm" onClick={resetAll}>
            Clear changes
          </Button>
        )}
      </div>

      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead>Class</TableHead>
              <TableHead>Current Room</TableHead>
              <TableHead>New Room</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((c, i) => {
              const changed = newRoomValue(c) !== c.roomId;
              return (
                <TableRow key={c.id} className={i % 2 === 1 ? "bg-muted/30" : undefined}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell className="text-muted-foreground">{c.roomLabel}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <div className="w-64">
                        <SearchableSelect
                          value={newRoomValue(c)}
                          onValueChange={(v) => setNewRoom(c.id, v)}
                          items={roomItems}
                          placeholder="Select a room"
                          searchPlaceholder="Search rooms or campuses…"
                          className="w-full"
                        />
                      </div>
                      {changed && (
                        <span className="shrink-0 rounded-md bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
                          changed
                        </span>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {visible.length === 0 && (
              <TableRow>
                <TableCell colSpan={3} className="text-center text-muted-foreground">
                  {classes.length === 0
                    ? "No classes with a room assigned."
                    : "No classes match these filters."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {changedRows.length} class{changedRows.length === 1 ? "" : "es"} with a new room
          {changedRows.length > 0 && " (counts every filter, not just visible rows)"}
        </p>
        <Button
          onClick={openReview}
          disabled={changedRows.length === 0 || loadingPreview}
        >
          {loadingPreview && <Loader2 className="size-4 animate-spin" />}
          Review Reassignment
        </Button>
      </div>

      <Dialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Review room reassignment</DialogTitle>
            <DialogDescription>
              {blocked
                ? "This reassignment collides with a booking outside the batch and can't be applied."
                : "Review the full chain, then apply it as one atomic operation."}
            </DialogDescription>
          </DialogHeader>

          {plan && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/30 p-3 text-sm">
                {plan.changes.map((c) => (
                  <div key={c.classId} className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{c.className}</span>
                    <span className="text-muted-foreground">{c.oldRoomName}</span>
                    <ArrowRight className="size-3.5 text-muted-foreground" />
                    <span className="font-medium">{c.newRoomName}</span>
                    <span className="text-xs text-muted-foreground">
                      ({c.movedSessions} session{c.movedSessions === 1 ? "" : "s"})
                    </span>
                  </div>
                ))}
              </div>

              {blocked && (
                <div className="flex flex-col gap-1 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                  <div className="flex items-center gap-1.5 font-semibold">
                    <AlertTriangle className="size-3.5" /> Blocked — conflicts outside this batch
                  </div>
                  {plan.conflicts.map((m, i) => (
                    <p key={i}>{m}</p>
                  ))}
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setPreview(null)}
              disabled={applying}
            >
              {blocked ? "Close" : "Cancel"}
            </Button>
            {!blocked && (
              <Button onClick={apply} disabled={applying}>
                {applying && <Loader2 className="size-4 animate-spin" />}
                Apply Reassignment
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
