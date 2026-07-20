"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Loader2, MoreHorizontal, Plus } from "lucide-react";
import type { Class, Program } from "@prisma/client";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { PageHeader } from "@/components/layout/page-header";
import { getActionErrorMessage } from "@/lib/action-error";
import { classSchema, type ClassInput } from "./schema";
import {
  createClass,
  updateClass,
  deactivateClass,
  reactivateClass,
} from "./actions";

type ClassWithProgram = Class & { program: Program };

const SEMESTER_NUMBERS = Array.from({ length: 8 }, (_, i) => i + 1);

function emptyValues(defaultIntakeYear: number): ClassInput {
  return {
    name: "",
    programId: "",
    intakeYear: defaultIntakeYear,
    section: "",
    studyMode: undefined,
    currentSemesterNumber: undefined,
  };
}

// Preview only — the server recomputes this itself from programId +
// intakeYear and never trusts a client-submitted value. Only shown once
// the intake year is a real 4-digit number (avoids a misleading preview
// mid-keystroke, e.g. after typing just "2").
function previewBatchCode(
  programCode: string | undefined,
  intakeYear: number | undefined
): string | null {
  if (!programCode || !intakeYear || String(intakeYear).length !== 4) {
    return null;
  }
  return `${programCode}${String(intakeYear).slice(-2)}`;
}

export function ClassesClient({
  classes,
  programs,
  defaultIntakeYear,
}: {
  classes: ClassWithProgram[];
  programs: Program[];
  defaultIntakeYear: number;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ClassWithProgram | null>(null);

  const form = useForm<ClassInput>({
    resolver: zodResolver(classSchema),
    defaultValues: emptyValues(defaultIntakeYear),
  });

  const programId = form.watch("programId");
  const intakeYear = form.watch("intakeYear");
  const section = form.watch("section");
  const studyMode = form.watch("studyMode");
  const selectedProgram = programs.find((p) => p.id === programId);
  const batchCode = previewBatchCode(selectedProgram?.code, intakeYear);
  const composedName =
    batchCode && section && studyMode
      ? `${batchCode}-${section}-${studyMode}`
      : null;

  function openCreate() {
    setEditing(null);
    form.reset(emptyValues(defaultIntakeYear));
    setDialogOpen(true);
  }

  function openEdit(cls: ClassWithProgram) {
    setEditing(cls);
    form.reset({
      name: cls.name,
      programId: cls.programId,
      // The batch's ORIGINAL intake year, not recomputed from "now" — this
      // is what keeps batchCode stable across a later edit in a different
      // current year.
      intakeYear: cls.intakeYear ?? undefined,
      section: cls.section ?? "",
      studyMode: cls.studyMode ?? undefined,
      currentSemesterNumber: cls.currentSemesterNumber ?? undefined,
    });
    setDialogOpen(true);
  }

  async function onSubmit(values: ClassInput) {
    try {
      if (editing) {
        await updateClass(editing.id, values);
        toast.success("Class updated.");
      } else {
        await createClass(values);
        toast.success("Class created.");
      }
      setDialogOpen(false);
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(
        getActionErrorMessage(
          error,
          "Something went wrong. That name may already exist in this program."
        )
      );
    }
  }

  async function onToggleActive(cls: ClassWithProgram) {
    try {
      if (cls.deletedAt) {
        await reactivateClass(cls.id);
        toast.success("Class reactivated.");
      } else {
        await deactivateClass(cls.id);
        toast.success("Class deactivated.");
      }
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(
        getActionErrorMessage(error, "Something went wrong. Please try again.")
      );
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Classes"
        description="Manage classes within programs."
        action={
          <Button onClick={openCreate} disabled={isPending}>
            {isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            Add class
          </Button>
        }
      />

      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Program</TableHead>
              <TableHead>Batch</TableHead>
              <TableHead>Section</TableHead>
              <TableHead>Mode</TableHead>
              <TableHead>Semester</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {classes.map((cls, i) => (
              <TableRow
                key={cls.id}
                className={i % 2 === 1 ? "bg-muted/30" : undefined}
              >
                <TableCell className="font-medium">{cls.name}</TableCell>
                <TableCell>{cls.program.name}</TableCell>
                <TableCell>{cls.batchCode ?? "—"}</TableCell>
                <TableCell>{cls.section ?? "—"}</TableCell>
                <TableCell>{cls.studyMode ?? "—"}</TableCell>
                <TableCell>{cls.currentSemesterNumber ?? "—"}</TableCell>
                <TableCell>
                  <Badge variant={cls.deletedAt ? "outline" : "published"}>
                    {cls.deletedAt ? "Inactive" : "Active"}
                  </Badge>
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={<Button variant="ghost" size="icon-sm" />}
                    >
                      <MoreHorizontal className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => openEdit(cls)}>
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => onToggleActive(cls)}>
                        {cls.deletedAt ? "Reactivate" : "Deactivate"}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
            {classes.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={8}
                  className="text-center text-muted-foreground"
                >
                  No classes yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit class" : "Add class"}</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              className="flex flex-col gap-4"
            >
              <FormField
                control={form.control}
                name="programId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Program</FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                      items={programs.map((program) => ({
                        value: program.id,
                        label: program.name,
                      }))}
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select a program" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {programs.map((program) => (
                          <SelectItem key={program.id} value={program.id}>
                            {program.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="intakeYear"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Intake year</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          placeholder="e.g. 2026"
                          value={field.value ?? ""}
                          onChange={(e) =>
                            field.onChange(
                              e.target.value ? Number(e.target.value) : undefined
                            )
                          }
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="section"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Section</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. A" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {batchCode && (
                <p className="text-sm text-muted-foreground">
                  Batch code:{" "}
                  <span className="font-medium text-foreground">{batchCode}</span>
                </p>
              )}

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="studyMode"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Study mode</FormLabel>
                      <Select
                        value={field.value ?? ""}
                        onValueChange={field.onChange}
                        items={[
                          { value: "FT", label: "Full-time" },
                          { value: "PT", label: "Part-time" },
                        ]}
                      >
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="Select" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="FT">Full-time</SelectItem>
                          <SelectItem value="PT">Part-time</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="currentSemesterNumber"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Current semester</FormLabel>
                      <Select
                        value={field.value ? String(field.value) : ""}
                        onValueChange={(value) =>
                          field.onChange(value ? Number(value) : undefined)
                        }
                        items={SEMESTER_NUMBERS.map((n) => ({
                          value: String(n),
                          label: `Semester ${n}`,
                        }))}
                      >
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="Select" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {SEMESTER_NUMBERS.map((n) => (
                            <SelectItem key={n} value={String(n)}>
                              Semester {n}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {composedName ? (
                <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm">
                  <span className="text-muted-foreground">Class name: </span>
                  <span className="font-medium">{composedName}</span>
                </div>
              ) : (
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Name</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. CS-Year2-A" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              <Button
                type="submit"
                disabled={form.formState.isSubmitting}
                className="mt-2"
              >
                {editing ? "Save changes" : "Create class"}
              </Button>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
