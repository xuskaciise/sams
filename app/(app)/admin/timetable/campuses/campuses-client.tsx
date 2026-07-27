"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { MoreHorizontal, Plus } from "lucide-react";
import type { Campus } from "@prisma/client";
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
import { getActionErrorMessage } from "@/lib/action-error";
import { campusSchema, type CampusInput } from "./schema";
import { createCampus, updateCampus, deactivateCampus, reactivateCampus } from "./actions";

export function CampusesClient({ campuses }: { campuses: Campus[] }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Campus | null>(null);

  const form = useForm<CampusInput>({
    resolver: zodResolver(campusSchema),
    defaultValues: { name: "", address: "" },
  });

  function openCreate() {
    setEditing(null);
    form.reset({ name: "", address: "" });
    setDialogOpen(true);
  }

  function openEdit(campus: Campus) {
    setEditing(campus);
    form.reset({ name: campus.name, address: campus.address ?? "" });
    setDialogOpen(true);
  }

  async function onSubmit(values: CampusInput) {
    try {
      if (editing) {
        await updateCampus(editing.id, values);
        toast.success("Campus updated.");
      } else {
        await createCampus(values);
        toast.success("Campus created.");
      }
      setDialogOpen(false);
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(
        getActionErrorMessage(error, "Something went wrong. That name may already be in use.")
      );
    }
  }

  async function onToggleActive(campus: Campus) {
    try {
      if (campus.deletedAt) {
        await reactivateCampus(campus.id);
        toast.success("Campus reactivated.");
      } else {
        await deactivateCampus(campus.id);
        toast.success("Campus deactivated.");
      }
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Something went wrong. Please try again."));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Rooms belong to a campus — a large university may have similarly named
          rooms across different campuses.
        </p>
        <Button onClick={openCreate} size="sm">
          <Plus className="size-4" />
          Add campus
        </Button>
      </div>

      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Address</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {campuses.map((campus, i) => (
              <TableRow key={campus.id} className={i % 2 === 1 ? "bg-muted/30" : undefined}>
                <TableCell className="font-medium">{campus.name}</TableCell>
                <TableCell className="text-muted-foreground">{campus.address ?? "—"}</TableCell>
                <TableCell>
                  <Badge variant={campus.deletedAt ? "outline" : "published"}>
                    {campus.deletedAt ? "Inactive" : "Active"}
                  </Badge>
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" />}>
                      <MoreHorizontal className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => openEdit(campus)}>Edit</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => onToggleActive(campus)}>
                        {campus.deletedAt ? "Reactivate" : "Deactivate"}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
            {campuses.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-muted-foreground">
                  No campuses yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit campus" : "Add campus"}</DialogTitle>
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
                      <Input {...field} placeholder="e.g. Main Campus" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="address"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Address (optional)</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="e.g. 123 University Ave" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button type="submit" disabled={form.formState.isSubmitting} className="mt-2">
                {editing ? "Save changes" : "Create campus"}
              </Button>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
