"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, Loader2 } from "lucide-react";
import type { AcademicYear, Semester } from "@prisma/client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { getActionErrorMessage } from "@/lib/action-error";
import { closeSemester } from "./actions";

type SemesterWithYear = Semester & { academicYear: AcademicYear };

export function CloseSemesterClient({
  semester,
  counts,
}: {
  semester: SemesterWithYear | null;
  counts: { total: number; draft: number; published: number };
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [closing, setClosing] = useState(false);

  async function onConfirm() {
    if (!semester) return;
    setClosing(true);
    try {
      await closeSemester(semester.id);
      toast.success(`${semester.name} closed.`);
      setConfirmOpen(false);
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(
        getActionErrorMessage(error, "Something went wrong. Please try again.")
      );
    } finally {
      setClosing(false);
    }
  }

  if (!semester) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No active semester</CardTitle>
          <CardDescription>
            There is nothing to close right now.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>
            {semester.name} ({semester.academicYear.name})
          </CardTitle>
          <CardDescription>
            {counts.total} assessment{counts.total === 1 ? "" : "s"} total —{" "}
            {counts.published} published, {counts.draft} still draft.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Closing locks every assessment in this semester (CLOSED):
            immutable, no more entry, corrections, or publishing.
          </p>
        </CardContent>
        <CardFooter>
          <Button variant="destructive" onClick={() => setConfirmOpen(true)}>
            Close semester
          </Button>
        </CardFooter>
      </Card>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Close {semester.name}?</DialogTitle>
            <DialogDescription>
              This cannot be undone. {counts.total} assessment
              {counts.total === 1 ? "" : "s"} will become permanently
              immutable.
            </DialogDescription>
          </DialogHeader>
          {counts.draft > 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>
                {counts.draft} assessment{counts.draft === 1 ? " is" : "s are"}{" "}
                still unpublished. Closing removes the ability to ever
                publish them — those marks will never reach students.
              </p>
            </div>
          )}
          <Button variant="destructive" onClick={onConfirm} disabled={closing}>
            {closing ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              "Yes, close this semester"
            )}
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
