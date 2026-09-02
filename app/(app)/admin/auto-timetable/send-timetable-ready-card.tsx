"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CalendarCheck, Check, Loader2, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getActionErrorMessage } from "@/lib/action-error";
import {
  previewSendTimetableReady,
  shareTimetableReady,
  type TimetableReadyPreview,
} from "./actions";
import type { WorkloadImportSemesterOption } from "../workload-import/semester-workload-import-client";

interface Props {
  semesterNumberOptions: WorkloadImportSemesterOption[];
}

type RowState = "idle" | "opening" | "opened";

function domainErrorMessage(error: unknown): string | null {
  return error instanceof Error && error.message === "DOMAIN_NOT_CONFIGURED"
    ? "Set a login domain on the WhatsApp page (Admin → WhatsApp) first."
    : null;
}

// "Timetable Ready" — a LECTURER-ONLY message, per semester-number batch.
// Delivered by a manual **wa.me share link** (NOT the automated Baileys
// worker): clicking "Share via WhatsApp" opens WhatsApp with the message
// pre-filled in a chat with that lecturer's number; the admin hits Send
// themselves. There's no bulk send — it's this per-lecturer list, one
// wa.me link per row, each marking itself "Link opened" once clicked.
// Lives on Workload Import & Auto-Timetable (the one place with a
// first-class "semester batch"), next to "Send timetable notifications"
// and "Clear timetable". Students never get anything here.
export function SendTimetableReadyCard({ semesterNumberOptions }: Props) {
  const router = useRouter();
  const [level, setLevel] = useState<number | null>(null);
  const [preview, setPreview] = useState<TimetableReadyPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [rowState, setRowState] = useState<Record<string, RowState>>({});

  if (semesterNumberOptions.length === 0) return null;

  const domainOk = !!preview?.domainConfigured;

  const openedCount = preview
    ? preview.lecturers.filter(
        (l) => rowState[l.lecturerId] === "opened" || !!l.linkOpenedAt
      ).length
    : 0;

  async function loadPreview(nextLevel: number) {
    setLevel(nextLevel);
    setPreview(null);
    setRowState({});
    setLoading(true);
    try {
      setPreview(await previewSendTimetableReady(nextLevel));
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not load lecturers for this semester level."));
    } finally {
      setLoading(false);
    }
  }

  function isOpened(lecturerId: string, linkOpenedAt: string | null): boolean {
    return rowState[lecturerId] === "opened" || !!linkOpenedAt;
  }

  async function shareOne(lecturerId: string, alreadyOpened: boolean) {
    if (level === null) return;
    // Open the tab SYNCHRONOUSLY inside the click handler — a window.open
    // after an awaited server call is blocked by popup blockers. We point
    // it at the wa.me URL once the action resolves, or close it on failure.
    const win = window.open("", "_blank");
    setRowState((s) => ({ ...s, [lecturerId]: "opening" }));
    try {
      const { status, url } = await shareTimetableReady(lecturerId, level, alreadyOpened);
      if (status === "opened" && url) {
        if (win) win.location.href = url;
        else window.open(url, "_blank");
        setRowState((s) => ({ ...s, [lecturerId]: "opened" }));
        router.refresh();
      } else {
        win?.close();
        setRowState((s) => ({ ...s, [lecturerId]: "idle" }));
        toast.warning("This lecturer has no phone number on file — nothing to share.");
      }
    } catch (error) {
      win?.close();
      if (error instanceof Error && error.message === "ALREADY_OPENED") {
        setRowState((s) => ({ ...s, [lecturerId]: "opened" }));
        toast.info("This link was already opened — use “Share again”.");
      } else {
        setRowState((s) => ({ ...s, [lecturerId]: "idle" }));
        toast.error(domainErrorMessage(error) ?? getActionErrorMessage(error, "Could not build the share link."));
      }
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <CalendarCheck className="mt-0.5 size-5 text-muted-foreground" />
          <div className="text-sm">
            <p className="font-semibold">Share &ldquo;Timetable Ready&rdquo; with lecturers</p>
            <p className="text-muted-foreground">
              Opens WhatsApp with a pre-filled &ldquo;your timetable is ready, view it at
              [domain]&rdquo; message for each lecturer — you hit Send. No login details; separate
              from Lecturer Login Credentials. One link per lecturer; work through the list below.
              Students get nothing.
            </p>
          </div>
        </div>
        <Select
          value={level !== null ? String(level) : null}
          onValueChange={(value) => value && loadPreview(Number(value))}
        >
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Semester level" />
          </SelectTrigger>
          <SelectContent>
            {semesterNumberOptions.map((opt) => (
              <SelectItem key={opt.semesterNumber} value={String(opt.semesterNumber)}>
                Level {opt.semesterNumber}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {loading && (
        <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading lecturers…
        </div>
      )}

      {!loading && preview && (
        <>
          {!domainOk && (
            <p className="text-xs text-amber-600">
              Set a login domain on the WhatsApp page (Admin → WhatsApp) before sharing.
            </p>
          )}

          {preview.lecturers.length === 0 ? (
            <p className="rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
              No lecturer has a built timetable at level {preview.semesterNumber} in{" "}
              {preview.semesterLabel} yet — nothing to share.
            </p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                {openedCount} of {preview.lecturers.length} link
                {preview.lecturers.length === 1 ? "" : "s"} opened
                {preview.pendingCount > 0 ? ` · ${preview.pendingCount} still to share` : ""}.
              </p>

              <div className="max-h-72 overflow-auto rounded-lg border border-border">
                <Table>
                  <TableHeader className="sticky top-0 bg-card">
                    <TableRow>
                      <TableHead>Lecturer</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="w-48" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.lecturers.map((l, i) => {
                      const st = rowState[l.lecturerId] ?? "idle";
                      const opened = isOpened(l.lecturerId, l.linkOpenedAt);
                      return (
                        <TableRow key={l.lecturerId} className={i % 2 === 1 ? "bg-muted/30" : undefined}>
                          <TableCell className="font-medium">{l.fullName}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {!l.hasPhone
                              ? "No phone number"
                              : opened
                                ? l.linkOpenedAt
                                  ? `Link opened ${new Date(l.linkOpenedAt).toLocaleDateString()}`
                                  : "Link opened"
                                : "Not shared"}
                          </TableCell>
                          <TableCell>
                            {!l.hasPhone ? (
                              <span className="text-xs text-muted-foreground">Set a phone first</span>
                            ) : !domainOk ? (
                              <span className="text-xs text-muted-foreground">Unavailable</span>
                            ) : st === "opening" ? (
                              <Button variant="outline" size="sm" disabled>
                                <Loader2 className="size-3.5 animate-spin" />
                              </Button>
                            ) : opened ? (
                              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                <Check className="size-3.5 text-green-600" />
                                <button
                                  type="button"
                                  className="underline hover:text-foreground"
                                  onClick={() => shareOne(l.lecturerId, true)}
                                >
                                  Share again
                                </button>
                              </span>
                            ) : (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => shareOne(l.lecturerId, false)}
                              >
                                <MessageCircle className="size-3.5" />
                                Share via WhatsApp
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
