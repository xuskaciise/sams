"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Loader2, MoreHorizontal, Plus } from "lucide-react";
import type { Assessment, AssessmentType } from "@prisma/client";
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
import { assessmentSchema, type AssessmentInput } from "./schema";
import {
  createAssessment,
  updateAssessment,
  deleteAssessment,
} from "./actions";

type AssessmentRow = Omit<Assessment, "maximumMarks"> & {
  maximumMarks: number;
  assessmentType: AssessmentType;
};

const STATUS_VARIANT: Record<
  AssessmentRow["status"],
  "draft" | "published" | "outline"
> = {
  DRAFT: "draft",
  PUBLISHED: "published",
  CLOSED: "outline",
};

export function AssessmentsClient({
  assignmentId,
  assessments,
  assessmentTypes,
  courseName,
  className,
  semesterName,
}: {
  assignmentId: string;
  assessments: AssessmentRow[];
  assessmentTypes: AssessmentType[];
  courseName: string;
  className: string;
  semesterName: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AssessmentRow | null>(null);

  const form = useForm<AssessmentInput>({
    resolver: zodResolver(assessmentSchema),
    defaultValues: {
      title: "",
      assessmentTypeId: "",
      maximumMarks: 100,
      mode: "INDIVIDUAL",
    },
  });

  function openCreate() {
    setEditing(null);
    form.reset({
      title: "",
      assessmentTypeId: "",
      maximumMarks: 100,
      mode: "INDIVIDUAL",
    });
    setDialogOpen(true);
  }

  function openEdit(assessment: AssessmentRow) {
    setEditing(assessment);
    form.reset({
      title: assessment.title,
      assessmentTypeId: assessment.assessmentTypeId,
      maximumMarks: assessment.maximumMarks,
      mode: assessment.mode,
    });
    setDialogOpen(true);
  }

  async function onSubmit(values: AssessmentInput) {
    try {
      if (editing) {
        await updateAssessment(editing.id, values);
        toast.success("Assessment updated.");
      } else {
        await createAssessment(assignmentId, values);
        toast.success("Assessment created.");
      }
      setDialogOpen(false);
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(
        getActionErrorMessage(error, "Something went wrong. Please try again.")
      );
    }
  }

  async function onDelete(assessment: AssessmentRow) {
    if (!window.confirm(`Delete "${assessment.title}"?`)) return;
    try {
      await deleteAssessment(assessment.id);
      toast.success("Assessment deleted.");
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
        title={courseName}
        description={`${className} · ${semesterName}`}
        action={
          <Button onClick={openCreate} disabled={isPending}>
            {isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            Add assessment
          </Button>
        }
      />

      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Max marks</TableHead>
              <TableHead>Mode</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {assessments.map((assessment, i) => (
              <TableRow
                key={assessment.id}
                className={i % 2 === 1 ? "bg-muted/30" : undefined}
              >
                <TableCell className="font-medium">
                  <Link
                    href={`/lecturer/assessments/${assessment.id}`}
                    className="hover:underline"
                  >
                    {assessment.title}
                  </Link>
                </TableCell>
                <TableCell>{assessment.assessmentType.name}</TableCell>
                <TableCell className="text-right">
                  {assessment.maximumMarks}
                </TableCell>
                <TableCell>{assessment.mode}</TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[assessment.status]}>
                    {assessment.status}
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
                      <DropdownMenuItem
                        onClick={() =>
                          router.push(`/lecturer/assessments/${assessment.id}`)
                        }
                      >
                        Manage results
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={assessment.status !== "DRAFT"}
                        onClick={() => openEdit(assessment)}
                      >
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={assessment.status !== "DRAFT"}
                        onClick={() => onDelete(assessment)}
                      >
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
            {assessments.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="text-center text-muted-foreground"
                >
                  No assessments yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editing ? "Edit assessment" : "Add assessment"}
            </DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              className="flex flex-col gap-4"
            >
              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Title</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. Quiz 1" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="assessmentTypeId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Type</FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                      items={assessmentTypes.map((t) => ({
                        value: t.id,
                        label: t.name,
                      }))}
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select a type" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {assessmentTypes.map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="maximumMarks"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Maximum marks</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        {...field}
                        onChange={(e) =>
                          field.onChange(e.target.valueAsNumber)
                        }
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="mode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Mode</FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                      disabled={!!editing}
                      items={[
                        { value: "INDIVIDUAL", label: "Individual" },
                        { value: "GROUP", label: "Group" },
                      ]}
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select a mode" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="INDIVIDUAL">Individual</SelectItem>
                        <SelectItem value="GROUP">Group</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button
                type="submit"
                disabled={form.formState.isSubmitting}
                className="mt-2"
              >
                {editing ? "Save changes" : "Create assessment"}
              </Button>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
