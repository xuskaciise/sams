"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Plus, Trash2 } from "lucide-react";
import type {
  Student,
  StudentGroup,
  GroupMember,
  User,
} from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getActionErrorMessage } from "@/lib/action-error";
import {
  createGroup,
  deleteGroup,
  addGroupMember,
  removeGroupMember,
  applySameMarkToGroup,
} from "./group-actions";

type StudentWithUser = Student & { user: User };
type GroupWithMembers = StudentGroup & {
  members: (GroupMember & { student: StudentWithUser })[];
};
type EnrollmentWithStudent = {
  id: string;
  student: StudentWithUser;
};

export function GroupsPanel({
  assessmentId,
  groups,
  enrollments,
  maximumMarks,
  disabled,
}: {
  assessmentId: string;
  groups: GroupWithMembers[];
  enrollments: EnrollmentWithStudent[];
  maximumMarks: number;
  disabled: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [createOpen, setCreateOpen] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [busyGroupId, setBusyGroupId] = useState<string | null>(null);
  const [addSelections, setAddSelections] = useState<Record<string, string>>(
    {}
  );
  const [markInputs, setMarkInputs] = useState<Record<string, string>>({});

  const groupedStudentIds = new Set(
    groups.flatMap((g) => g.members.map((m) => m.studentId))
  );
  const unassigned = enrollments.filter(
    (e) => !groupedStudentIds.has(e.student.id)
  );

  async function onCreateGroup() {
    if (!groupName.trim()) return;
    try {
      await createGroup(assessmentId, { name: groupName.trim() });
      toast.success("Group created.");
      setGroupName("");
      setCreateOpen(false);
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(
        getActionErrorMessage(error, "Something went wrong. Please try again.")
      );
    }
  }

  async function onDeleteGroup(groupId: string) {
    if (!window.confirm("Delete this group and remove all its members?"))
      return;
    setBusyGroupId(groupId);
    try {
      await deleteGroup(assessmentId, groupId);
      toast.success("Group deleted.");
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(
        getActionErrorMessage(error, "Something went wrong. Please try again.")
      );
    } finally {
      setBusyGroupId(null);
    }
  }

  async function onAddMember(groupId: string) {
    const studentId = addSelections[groupId];
    if (!studentId) return;
    setBusyGroupId(groupId);
    try {
      await addGroupMember(assessmentId, groupId, studentId);
      toast.success("Member added.");
      setAddSelections((prev) => ({ ...prev, [groupId]: "" }));
      startTransition(() => router.refresh());
    } catch (error) {
      if (error instanceof Error && error.message === "ALREADY_IN_GROUP") {
        toast.error("That student is already in a group for this assessment.");
      } else {
        toast.error(
          getActionErrorMessage(error, "Something went wrong. Please try again.")
        );
      }
    } finally {
      setBusyGroupId(null);
    }
  }

  async function onRemoveMember(groupId: string, memberId: string) {
    setBusyGroupId(groupId);
    try {
      await removeGroupMember(assessmentId, memberId);
      toast.success("Member removed.");
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(
        getActionErrorMessage(error, "Something went wrong. Please try again.")
      );
    } finally {
      setBusyGroupId(null);
    }
  }

  async function onApplyMark(groupId: string) {
    const raw = markInputs[groupId];
    const mark = raw === undefined ? NaN : Number(raw);
    if (Number.isNaN(mark)) {
      toast.error("Enter a valid mark first.");
      return;
    }
    if (mark < 0 || mark > maximumMarks) {
      toast.error(`Mark must be between 0 and ${maximumMarks}.`);
      return;
    }
    setBusyGroupId(groupId);
    try {
      await applySameMarkToGroup(assessmentId, groupId, { mark });
      toast.success("Mark applied to all group members.");
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(
        getActionErrorMessage(error, "Something went wrong. Please try again.")
      );
    } finally {
      setBusyGroupId(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button onClick={() => setCreateOpen(true)} disabled={disabled}>
          <Plus className="size-4" />
          Add group
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {groups.map((group) => (
          <Card key={group.id}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>{group.name}</CardTitle>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={disabled || busyGroupId === group.id}
                  onClick={() => onDeleteGroup(group.id)}
                >
                  <Trash2 className="size-4" />
                  <span className="sr-only">Delete group</span>
                </Button>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <ul className="flex flex-col gap-1">
                {group.members.map((member) => (
                  <li
                    key={member.id}
                    className="flex items-center justify-between text-sm"
                  >
                    <span>
                      {member.student.user.fullName}{" "}
                      <span className="text-muted-foreground">
                        ({member.student.studentNo})
                      </span>
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      disabled={disabled || busyGroupId === group.id}
                      onClick={() => onRemoveMember(group.id, member.id)}
                    >
                      <Trash2 className="size-3" />
                      <span className="sr-only">Remove member</span>
                    </Button>
                  </li>
                ))}
                {group.members.length === 0 && (
                  <li className="text-sm text-muted-foreground">
                    No members yet.
                  </li>
                )}
              </ul>

              {!disabled && (
                <div className="flex gap-2">
                  <Select
                    value={addSelections[group.id] ?? ""}
                    onValueChange={(value) =>
                      setAddSelections((prev) => ({
                        ...prev,
                        [group.id]: value ?? "",
                      }))
                    }
                    items={unassigned.map((e) => ({
                      value: e.student.id,
                      label: `${e.student.user.fullName} (${e.student.studentNo})`,
                    }))}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Add student…" />
                    </SelectTrigger>
                    <SelectContent>
                      {unassigned.map((e) => (
                        <SelectItem key={e.student.id} value={e.student.id}>
                          {e.student.user.fullName} ({e.student.studentNo})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="outline"
                    disabled={busyGroupId === group.id || !addSelections[group.id]}
                    onClick={() => onAddMember(group.id)}
                  >
                    Add
                  </Button>
                </div>
              )}
            </CardContent>
            <CardFooter>
              <div className="flex w-full items-end gap-2">
                <div className="flex-1">
                  <Label className="mb-1 text-xs text-muted-foreground">
                    Same mark for all members
                  </Label>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    max={maximumMarks}
                    disabled={disabled || group.members.length === 0}
                    value={markInputs[group.id] ?? ""}
                    onChange={(e) =>
                      setMarkInputs((prev) => ({
                        ...prev,
                        [group.id]: e.target.value,
                      }))
                    }
                  />
                </div>
                <Button
                  disabled={
                    disabled ||
                    busyGroupId === group.id ||
                    group.members.length === 0
                  }
                  onClick={() => onApplyMark(group.id)}
                >
                  {busyGroupId === group.id ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    "Apply"
                  )}
                </Button>
              </div>
            </CardFooter>
          </Card>
        ))}
        {groups.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No groups yet. Add a group to start assigning members.
          </p>
        )}
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add group</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <Label htmlFor="group-name">Name</Label>
              <Input
                id="group-name"
                placeholder="e.g. Group A"
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
              />
            </div>
            <Button onClick={onCreateGroup} disabled={!groupName.trim()}>
              Create group
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
