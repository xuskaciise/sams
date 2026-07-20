"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import type { Department } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { getActionErrorMessage } from "@/lib/action-error";
import { updateDeanDepartments } from "../roles/actions";

export function DeanDepartmentsDialog({
  open,
  onOpenChange,
  userId,
  userName,
  initialDepartmentIds,
  departments,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  userName: string;
  initialDepartmentIds: string[];
  departments: Department[];
  onSaved: () => void;
}) {
  const [departmentIds, setDepartmentIds] = useState<Set<string>>(
    new Set(initialDepartmentIds)
  );
  const [saving, setSaving] = useState(false);

  async function onSave() {
    setSaving(true);
    try {
      await updateDeanDepartments(userId, {
        departmentIds: Array.from(departmentIds),
      });
      toast.success("Faculties updated.");
      onOpenChange(false);
      onSaved();
    } catch (error) {
      toast.error(
        getActionErrorMessage(error, "Something went wrong. Please try again.")
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Faculties overseen — {userName}</DialogTitle>
          <DialogDescription>
            Departments this dean can see and act on (ownership transfers,
            reports, dashboard). A dean with none checked sees no data
            until at least one is assigned.
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto pr-1">
          {departments.map((department) => (
            <div key={department.id} className="flex items-center gap-2">
              <Checkbox
                id={`dean-dept-${department.id}`}
                checked={departmentIds.has(department.id)}
                onCheckedChange={(value) =>
                  setDepartmentIds((prev) => {
                    const next = new Set(prev);
                    if (value === true) next.add(department.id);
                    else next.delete(department.id);
                    return next;
                  })
                }
              />
              <Label htmlFor={`dean-dept-${department.id}`}>
                {department.name} ({department.code})
              </Label>
            </div>
          ))}
          {departments.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No departments exist yet — add one under Academic Structure
              first.
            </p>
          )}
        </div>

        <Button onClick={onSave} disabled={saving}>
          {saving && <Loader2 className="size-4 animate-spin" />}
          Save faculties
        </Button>
      </DialogContent>
    </Dialog>
  );
}
