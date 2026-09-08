"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeftRight, Loader2 } from "lucide-react";
import type { Class, Program, Room, Campus } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { getActionErrorMessage } from "@/lib/action-error";
import { swapClassRooms } from "./actions";

type RoomWithCampus = Room & { campus: Campus };
type ClassWithProgram = Class & { program: Program; room: RoomWithCampus | null };

// A focused two-picker dialog — the two classes to swap may be anywhere
// in the (server-paginated) Classes table, so a bulk row-select action
// isn't possible here. Only ACTIVE classes that already HAVE a room are
// offered: a swap exchanges rooms, so there's nothing to swap otherwise
// (the server re-verifies this too).
export function SwapRoomsDialog({
  open,
  onOpenChange,
  classes,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  classes: ClassWithProgram[];
}) {
  const router = useRouter();
  const [classAId, setClassAId] = useState("");
  const [classBId, setClassBId] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const eligible = classes.filter((c) => c.roomId && c.room && !c.deletedAt);

  const classA = eligible.find((c) => c.id === classAId) ?? null;
  const classB = eligible.find((c) => c.id === classBId) ?? null;
  const canSwap = !!classA && !!classB && classA.id !== classB.id;

  function itemsExcluding(otherId: string) {
    return eligible
      .filter((c) => c.id !== otherId)
      .map((c) => ({
        value: c.id,
        label: `${c.name} — ${c.room!.name}`,
        keywords: [c.room!.campus.name, c.program.name],
      }));
  }

  function close() {
    setClassAId("");
    setClassBId("");
    onOpenChange(false);
  }

  async function handleSwap() {
    if (!classA || !classB) return;
    setSubmitting(true);
    try {
      const result = await swapClassRooms({
        classAId: classA.id,
        classBId: classB.id,
      });
      const moved = result.classA.movedSessions + result.classB.movedSessions;
      toast.success(
        `Rooms swapped — ${result.classA.name} now uses ${result.classA.newRoomName}, ` +
          `${result.classB.name} now uses ${result.classB.newRoomName}` +
          (moved > 0
            ? ` (${moved} session${moved === 1 ? "" : "s"} moved).`
            : ".")
      );
      router.refresh();
      close();
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not swap the rooms."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Swap rooms</DialogTitle>
          <DialogDescription>
            Exchange two classes&apos; assigned rooms. Both classes — and every
            existing scheduled session they have — move to the other&apos;s room,
            permanently going forward. Only classes that already have a room
            assigned are listed.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>Class A</Label>
            <SearchableSelect
              value={classAId}
              onValueChange={setClassAId}
              items={itemsExcluding(classBId)}
              placeholder="Select a class"
              searchPlaceholder="Search classes or rooms…"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Class B</Label>
            <SearchableSelect
              value={classBId}
              onValueChange={setClassBId}
              items={itemsExcluding(classAId)}
              placeholder="Select a class"
              searchPlaceholder="Search classes or rooms…"
            />
          </div>

          {classA && classB && (
            <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium">{classA.name}</span>
                <span className="text-muted-foreground">
                  currently {classA.room!.name} — {classA.room!.campus.name}
                </span>
              </div>
              <div className="my-1.5 flex justify-center text-muted-foreground">
                <ArrowLeftRight className="size-4" />
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium">{classB.name}</span>
                <span className="text-muted-foreground">
                  currently {classB.room!.name} — {classB.room!.campus.name}
                </span>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                After the swap: {classA.name} → {classB.room!.name}, {classB.name}{" "}
                → {classA.room!.name}. All their existing sessions move too.
              </p>
            </div>
          )}

          {eligible.length < 2 && (
            <p className="text-sm text-muted-foreground">
              At least two classes need a room assigned before a swap is possible.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={close} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSwap} disabled={!canSwap || submitting}>
            {submitting && <Loader2 className="size-4 animate-spin" />}
            Swap rooms
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
