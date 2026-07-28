"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { MoreHorizontal, Plus } from "lucide-react";
import type { Campus, Room } from "@prisma/client";
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
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { getActionErrorMessage } from "@/lib/action-error";
import { roomSchema, type RoomInput } from "./schema";
import { createRoom, updateRoom, deactivateRoom, reactivateRoom } from "./actions";
import { BulkAddRoomsDialog } from "./bulk-add-rooms-dialog";

type RoomWithCampus = Room & { campus: Campus };

const ALL_CAMPUSES_VALUE = "";

export function RoomsClient({
  rooms,
  campuses,
  canManage = true,
}: {
  rooms: RoomWithCampus[];
  campuses: Campus[];
  canManage?: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false);
  const [editing, setEditing] = useState<RoomWithCampus | null>(null);
  const [campusFilter, setCampusFilter] = useState(ALL_CAMPUSES_VALUE);

  const form = useForm<RoomInput>({
    resolver: zodResolver(roomSchema),
    defaultValues: { campusId: "", name: "", capacity: undefined },
  });

  const visibleRooms = useMemo(
    () => (campusFilter ? rooms.filter((r) => r.campusId === campusFilter) : rooms),
    [rooms, campusFilter]
  );

  function openCreate() {
    setEditing(null);
    form.reset({ campusId: campusFilter || "", name: "", capacity: undefined });
    setDialogOpen(true);
  }

  function openEdit(room: RoomWithCampus) {
    setEditing(room);
    form.reset({ campusId: room.campusId, name: room.name, capacity: room.capacity ?? undefined });
    setDialogOpen(true);
  }

  async function onSubmit(values: RoomInput) {
    try {
      if (editing) {
        await updateRoom(editing.id, values);
        toast.success("Room updated.");
      } else {
        await createRoom(values);
        toast.success("Room created.");
      }
      setDialogOpen(false);
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(
        getActionErrorMessage(
          error,
          "Something went wrong. That name may already be in use at this campus."
        )
      );
    }
  }

  async function onToggleActive(room: RoomWithCampus) {
    try {
      if (room.deletedAt) {
        await reactivateRoom(room.id);
        toast.success("Room reactivated.");
      } else {
        await deactivateRoom(room.id);
        toast.success("Room deactivated.");
      }
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Something went wrong. Please try again."));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Rooms belong to a campus and are shared across every faculty and semester.
        </p>
        {canManage && (
          <div className="flex gap-2">
            <Button onClick={() => setBulkDialogOpen(true)} size="sm" variant="outline">
              Bulk add rooms
            </Button>
            <Button onClick={openCreate} size="sm">
              <Plus className="size-4" />
              Add room
            </Button>
          </div>
        )}
      </div>

      <div className="w-56">
        <SearchableSelect
          value={campusFilter}
          onValueChange={setCampusFilter}
          items={[
            { value: ALL_CAMPUSES_VALUE, label: "All campuses" },
            ...campuses.map((c) => ({ value: c.id, label: c.name })),
          ]}
          placeholder="Campus"
          searchPlaceholder="Search campuses…"
          className="w-full"
        />
      </div>

      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Campus</TableHead>
              <TableHead className="text-right">Capacity</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleRooms.map((room, i) => (
              <TableRow key={room.id} className={i % 2 === 1 ? "bg-muted/30" : undefined}>
                <TableCell className="font-medium">{room.name}</TableCell>
                <TableCell className="text-muted-foreground">{room.campus.name}</TableCell>
                <TableCell className="text-right">{room.capacity ?? "—"}</TableCell>
                <TableCell>
                  <Badge variant={room.deletedAt ? "outline" : "published"}>
                    {room.deletedAt ? "Inactive" : "Active"}
                  </Badge>
                </TableCell>
                <TableCell>
                  {canManage && (
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" />}>
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => openEdit(room)}>Edit</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => onToggleActive(room)}>
                          {room.deletedAt ? "Reactivate" : "Deactivate"}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {visibleRooms.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground">
                  No rooms yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit room" : "Add room"}</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4">
              <FormField
                control={form.control}
                name="campusId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Campus</FormLabel>
                    <SearchableSelect
                      value={field.value}
                      onValueChange={field.onChange}
                      items={campuses.map((c) => ({ value: c.id, label: c.name }))}
                      placeholder="Select a campus"
                      searchPlaceholder="Search campuses…"
                      emptyMessage="No campuses yet — add one in the Campuses tab first."
                      className="w-full"
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="e.g. A101" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="capacity"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Capacity (optional)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        placeholder="e.g. 40"
                        value={field.value ?? ""}
                        onChange={(e) =>
                          field.onChange(e.target.value ? Number(e.target.value) : undefined)
                        }
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button type="submit" disabled={form.formState.isSubmitting} className="mt-2">
                {editing ? "Save changes" : "Create room"}
              </Button>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <BulkAddRoomsDialog
        open={bulkDialogOpen}
        onOpenChange={setBulkDialogOpen}
        campuses={campuses}
        onDone={() => startTransition(() => router.refresh())}
      />
    </div>
  );
}
