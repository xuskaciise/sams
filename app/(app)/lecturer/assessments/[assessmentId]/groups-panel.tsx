"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import type { Student, StudentGroup, GroupMember, User } from "@prisma/client";
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
import { getActionErrorMessage } from "@/lib/action-error";
import { applySameMarkToGroup } from "./group-actions";

type StudentWithUser = Student & { user: User };
type GroupWithMembers = StudentGroup & {
  members: (GroupMember & { student: StudentWithUser })[];
};

export function GroupsPanel({
  assessmentId,
  assignmentId,
  groups,
  maximumMarks,
  disabled,
}: {
  assessmentId: string;
  assignmentId: string;
  groups: GroupWithMembers[];
  maximumMarks: number;
  disabled: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busyGroupId, setBusyGroupId] = useState<string | null>(null);
  const [markInputs, setMarkInputs] = useState<Record<string, string>>({});

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
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Groups are shared across this course&apos;s assessments.
        </p>
        <Button
          variant="outline"
          size="sm"
          nativeButton={false}
          render={
            <Link href={`/lecturer/assignments/${assignmentId}/groups`} />
          }
        >
          Manage groups
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {groups.map((group) => (
          <Card key={group.id}>
            <CardHeader>
              <CardTitle>{group.name}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <ul className="flex flex-col gap-1">
                {group.members.map((member) => (
                  <li key={member.id} className="text-sm">
                    {member.student.user.fullName}{" "}
                    <span className="text-muted-foreground">
                      ({member.student.studentNo})
                    </span>
                  </li>
                ))}
                {group.members.length === 0 && (
                  <li className="text-sm text-muted-foreground">
                    No members yet.
                  </li>
                )}
              </ul>
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
            No groups yet.{" "}
            <Link
              href={`/lecturer/assignments/${assignmentId}/groups`}
              className="underline"
            >
              Create one
            </Link>{" "}
            to start assigning members.
          </p>
        )}
      </div>
    </div>
  );
}
