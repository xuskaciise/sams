"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
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
import { updateClassRoom } from "./actions";

type RoomWithCampus = Room & { campus: Campus };
type ClassWithProgram = Class & { program: Program; room: RoomWithCampus | null };

const NO_ROOM = "";

// A minimal, focused dialog — deliberately the ONLY thing it can change is
// the class's room. No name, program, section, or study mode field exists
// here at all, so this entry point can never touch (or be blamed for)
// name-composition/duplicate-name logic — see updateClassRoom in
// actions.ts, which mirrors that isolation server-side.
//
// The selected room is a value CONTROLLED BY THE PARENT (set synchronously
// in its "Change room" click handler, the same event-driven pattern the
// Edit dialog's own form.reset(...) already uses on this page) rather than
// state this component resets via an effect — that's what makes reopening
// for a different class always start from that class's own current room,
// with nothing to synchronize after the fact.
export function ChangeRoomDialog({
  cls,
  rooms,
  roomId,
  onRoomIdChange,
  open,
  onOpenChange,
}: {
  cls: ClassWithProgram | null;
  rooms: RoomWithCampus[];
  roomId: string;
  onRoomIdChange: (roomId: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  if (!cls) return null;

  const unchanged = roomId === (cls.roomId ?? NO_ROOM);

  async function handleSave() {
    if (!cls) return;
    setSubmitting(true);
    try {
      const result = await updateClassRoom(cls.id, { roomId: roomId || null });
      if (result.roomChange) {
        toast.success(
          `Room updated — ${result.roomChange.movedSessions} session${
            result.roomChange.movedSessions === 1 ? "" : "s"
          } moved to ${result.roomChange.newRoomName}.`
        );
      } else if (unchanged) {
        toast.success("No change — already using this room.");
      } else {
        toast.success("Room updated.");
      }
      onOpenChange(false);
      router.refresh();
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not update the room."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change room</DialogTitle>
          <DialogDescription>
            {cls.name} — only the room changes here. Every existing scheduled
            session for this class moves along with it.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>Current room</Label>
            <p className="text-sm text-muted-foreground">
              {cls.room ? `${cls.room.name} — ${cls.room.campus.name}` : "Not set"}
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>New room</Label>
            <SearchableSelect
              value={roomId}
              onValueChange={onRoomIdChange}
              items={[
                { value: NO_ROOM, label: "No room" },
                ...rooms.map((r) => ({
                  value: r.id,
                  label: `${r.name} — ${r.campus.name}`,
                  keywords: [r.campus.name],
                })),
              ]}
              placeholder="Select a room"
              searchPlaceholder="Search rooms or campuses…"
            />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={submitting}>
            {submitting && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
