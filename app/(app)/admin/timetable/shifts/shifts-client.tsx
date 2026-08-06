"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { MoreHorizontal, Plus } from "lucide-react";
import type { Shift } from "@prisma/client";
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
import { getActionErrorMessage } from "@/lib/action-error";
import { shiftSchema, type ShiftInput } from "./schema";
import { createShift, updateShift, deactivateShift, reactivateShift } from "./actions";

const ALL_MODES_VALUE = "";

const PERIOD_LABELS: Record<"MORNING" | "AFTERNOON", string> = {
  MORNING: "Morning (Subax)",
  AFTERNOON: "Afternoon (Galab)",
};

export function ShiftsClient({
  shifts,
  canManage = true,
}: {
  shifts: Shift[];
  canManage?: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Shift | null>(null);
  const [modeFilter, setModeFilter] = useState(ALL_MODES_VALUE);

  const form = useForm<ShiftInput>({
    resolver: zodResolver(shiftSchema),
    defaultValues: { name: "", studyMode: "FT", period: undefined, startTime: "", endTime: "" },
  });
  const studyModeField = form.watch("studyMode");

  const visibleShifts = useMemo(
    () => (modeFilter ? shifts.filter((s) => s.studyMode === modeFilter) : shifts),
    [shifts, modeFilter]
  );

  function openCreate() {
    setEditing(null);
    form.reset({
      name: "",
      studyMode: (modeFilter as "FT" | "PT") || "FT",
      period: undefined,
      startTime: "",
      endTime: "",
    });
    setDialogOpen(true);
  }

  function openEdit(shift: Shift) {
    setEditing(shift);
    form.reset({
      name: shift.name,
      studyMode: shift.studyMode,
      period: shift.period ?? undefined,
      startTime: shift.startTime,
      endTime: shift.endTime,
    });
    setDialogOpen(true);
  }

  // Period is FT-only and not applicable to PT — clear a stale pick
  // whenever study mode moves away from FT, same pattern as the Class form.
  useEffect(() => {
    if (studyModeField !== "FT") form.setValue("period", undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studyModeField]);

  async function onSubmit(values: ShiftInput) {
    try {
      if (editing) {
        await updateShift(editing.id, values);
        toast.success("Shift updated.");
      } else {
        await createShift(values);
        toast.success("Shift created.");
      }
      setDialogOpen(false);
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(
        getActionErrorMessage(
          error,
          "Something went wrong. That name may already be in use for this study mode."
        )
      );
    }
  }

  async function onToggleActive(shift: Shift) {
    try {
      if (shift.deletedAt) {
        await reactivateShift(shift.id);
        toast.success("Shift reactivated.");
      } else {
        await deactivateShift(shift.id);
        toast.success("Shift deactivated.");
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
          Reusable time templates offered when entering a session — a study mode can have
          several shifts.
        </p>
        {canManage && (
          <Button onClick={openCreate} size="sm">
            <Plus className="size-4" />
            Add shift
          </Button>
        )}
      </div>

      <div className="w-44">
        <Select
          value={modeFilter || "all"}
          onValueChange={(value) => setModeFilter(!value || value === "all" ? "" : value)}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Study mode" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All study modes</SelectItem>
            <SelectItem value="FT">FT</SelectItem>
            <SelectItem value="PT">PT</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Study mode</TableHead>
              <TableHead>Period</TableHead>
              <TableHead>Time</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleShifts.map((shift, i) => (
              <TableRow key={shift.id} className={i % 2 === 1 ? "bg-muted/30" : undefined}>
                <TableCell className="font-medium">{shift.name}</TableCell>
                <TableCell className="text-muted-foreground">{shift.studyMode}</TableCell>
                <TableCell className="text-muted-foreground">
                  {shift.studyMode === "FT" ? (
                    shift.period ? (
                      PERIOD_LABELS[shift.period]
                    ) : (
                      <span className="text-amber-700 dark:text-amber-400">Not set</span>
                    )
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {shift.startTime}–{shift.endTime}
                </TableCell>
                <TableCell>
                  <Badge variant={shift.deletedAt ? "outline" : "published"}>
                    {shift.deletedAt ? "Inactive" : "Active"}
                  </Badge>
                </TableCell>
                <TableCell>
                  {canManage && (
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" />}>
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => openEdit(shift)}>Edit</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => onToggleActive(shift)}>
                          {shift.deletedAt ? "Reactivate" : "Deactivate"}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {visibleShifts.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground">
                  No shifts yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit shift" : "Add shift"}</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="e.g. Shift 1" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="studyMode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Study mode</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select a study mode" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="FT">FT</SelectItem>
                        <SelectItem value="PT">PT</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {studyModeField === "FT" && (
                <FormField
                  control={form.control}
                  name="period"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Period</FormLabel>
                      <Select value={field.value ?? ""} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="Select a period" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="MORNING">Morning (Subax)</SelectItem>
                          <SelectItem value="AFTERNOON">Afternoon (Galab)</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}
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
              <Button type="submit" disabled={form.formState.isSubmitting} className="mt-2">
                {editing ? "Save changes" : "Create shift"}
              </Button>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
