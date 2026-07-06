"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pencil, Plus, Trash2 } from "lucide-react";
import type { Student, StudentGroup, GroupMember, User } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
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
import { PageHeader } from "@/components/layout/page-header";
import { getActionErrorMessage } from "@/lib/action-error";
import {
  createGroup,
  renameGroup,
  deleteGroup,
  addGroupMember,
  removeGroupMember,
} from "./actions";

type StudentWithUser = Student & { user: User };
type GroupWithMembers = StudentGroup & {
  members: (GroupMember & { student: StudentWithUser })[];
};
type EnrollmentWithStudent = {
  id: string;
  student: StudentWithUser;
};

export function GroupsClient({
  assignmentId,
  groups,
  enrollments,
  courseName,
  className,
  semesterName,
}: {
  assignmentId: string;
  groups: GroupWithMembers[];
  enrollments: EnrollmentWithStudent[];
  courseName: string;
  className: string;
  semesterName: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [createOpen, setCreateOpen] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [renaming, setRenaming] = useState<GroupWithMembers | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [busyGroupId, setBusyGroupId] = useState<string | null>(null);
  const [addSelections, setAddSelections] = useState<Record<string, string>>(
    {}
  );

  const groupedStudentIds = new Set(
    groups.flatMap((g) => g.members.map((m) => m.studentId))
  );
  const unassigned = enrollments.filter(
    (e) => !groupedStudentIds.has(e.student.id)
  );

  async function onCreateGroup() {
    if (!groupName.trim()) return;
    try {
      await createGroup(assignmentId, { name: groupName.trim() });
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

  function openRename(group: GroupWithMembers) {
    setRenaming(group);
    setRenameValue(group.name);
  }

  async function onRename() {
    if (!renaming || !renameValue.trim()) return;
    try {
      await renameGroup(assignmentId, renaming.id, {
        name: renameValue.trim(),
      });
      toast.success("Group renamed.");
      setRenaming(null);
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
      await deleteGroup(assignmentId, groupId);
      toast.success("Group deleted.");
      startTransition(() => router.refresh());
    } catch (error) {
      if (error instanceof Error && error.message === "HAS_PUBLISHED_RESULTS") {
        toast.error(
          "This group has published results. Remove it from those results first, or leave it as-is."
        );
      } else {
        toast.error(
          getActionErrorMessage(error, "Something went wrong. Please try again.")
        );
      }
    } finally {
      setBusyGroupId(null);
    }
  }

  async function onAddMember(groupId: string) {
    const studentId = addSelections[groupId];
    if (!studentId) return;
    setBusyGroupId(groupId);
    try {
      await addGroupMember(assignmentId, groupId, studentId);
      toast.success("Member added.");
      setAddSelections((prev) => ({ ...prev, [groupId]: "" }));
      startTransition(() => router.refresh());
    } catch (error) {
      if (error instanceof Error && error.message === "ALREADY_IN_GROUP") {
        toast.error("That student is already in a group for this course.");
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
      await removeGroupMember(assignmentId, memberId);
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

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Groups"
        description={`${courseName} · ${className} · ${semesterName}`}
        action={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            Add group
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {groups.map((group) => (
          <Card key={group.id}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>{group.name}</CardTitle>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={busyGroupId === group.id}
                    onClick={() => openRename(group)}
                  >
                    <Pencil className="size-4" />
                    <span className="sr-only">Rename group</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={busyGroupId === group.id}
                    onClick={() => onDeleteGroup(group.id)}
                  >
                    <Trash2 className="size-4" />
                    <span className="sr-only">Delete group</span>
                  </Button>
                </div>
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
                      disabled={busyGroupId === group.id}
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
            </CardContent>
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

      <Dialog
        open={!!renaming}
        onOpenChange={(open) => !open && setRenaming(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename group</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <Label htmlFor="rename-group">Name</Label>
              <Input
                id="rename-group"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
              />
            </div>
            <Button onClick={onRename} disabled={!renameValue.trim()}>
              Save
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
