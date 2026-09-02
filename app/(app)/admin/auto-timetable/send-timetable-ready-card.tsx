"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CalendarCheck, Check, Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getActionErrorMessage } from "@/lib/action-error";
import {
  previewSendTimetableReady,
  sendTimetableReadyToLecturer,
  sendTimetableReadyBatch,
  type TimetableReadyPreview,
} from "./actions";
import type { WorkloadImportSemesterOption } from "../workload-import/semester-workload-import-client";

interface Props {
  semesterNumberOptions: WorkloadImportSemesterOption[];
}

type RowState = "idle" | "sending" | "sent";

function domainError(error: unknown): string | null {
  return error instanceof Error && error.message === "DOMAIN_NOT_CONFIGURED"
    ? "Set a login domain on the WhatsApp page (Admin → WhatsApp) before sending."
    : null;
}

// "Timetable Ready" — a LECTURER-ONLY manual WhatsApp, per semester-number
// batch, fully independent of "Lecturer Login Credentials" (different
// template, no username/password, its own per-(lecturer, semester)
// sent-state). Lives here on Workload Import & Auto-Timetable because
// this is the one place "a semester batch" is a first-class concept (the
// level picker) and where auto-generate/build happens — "tell the
// lecturers their timetable is ready" is the natural next step, right
// alongside the sibling "Send timetable notifications" (students +
// lecturers) and "Clear timetable" batch cards. Students never get
// anything from here.
export function SendTimetableReadyCard({ semesterNumberOptions }: Props) {
  const router = useRouter();
  const [level, setLevel] = useState<number | null>(null);
  const [preview, setPreview] = useState<TimetableReadyPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [rowState, setRowState] = useState<Record<string, RowState>>({});
  const [bulkSending, setBulkSending] = useState(false);

  if (semesterNumberOptions.length === 0) return null;

  const canSend = !!preview && preview.whatsappEnabled && preview.domainConfigured;
  const blockedReason = !preview
    ? null
    : !preview.domainConfigured
      ? "Set a login domain on the WhatsApp page (Admin → WhatsApp) before sending."
      : !preview.whatsappEnabled
        ? "Turn WhatsApp notifications on (Admin → WhatsApp) to send."
        : null;

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

  function statusFor(lecturerId: string, notifiedAt: string | null): RowState {
    return rowState[lecturerId] ?? (notifiedAt ? "sent" : "idle");
  }

  async function sendOne(lecturerId: string) {
    if (level === null) return;
    setRowState((s) => ({ ...s, [lecturerId]: "sending" }));
    try {
      const { status } = await sendTimetableReadyToLecturer(lecturerId, level);
      if (status === "sent") {
        setRowState((s) => ({ ...s, [lecturerId]: "sent" }));
        toast.success("Timetable-ready message queued.");
        router.refresh();
      } else {
        setRowState((s) => ({ ...s, [lecturerId]: "idle" }));
        toast.warning("Nothing queued — WhatsApp is off or the lecturer has no phone number.");
      }
    } catch (error) {
      setRowState((s) => ({ ...s, [lecturerId]: "idle" }));
      toast.error(domainError(error) ?? getActionErrorMessage(error, "Could not send."));
    }
  }

  async function sendAllEligible() {
    if (level === null || !preview || preview.eligibleCount === 0) return;
    setBulkSending(true);
    try {
      const { results } = await sendTimetableReadyBatch(level);
      const sent = results.filter((r) => r.status === "sent").length;
      const skipped = results.length - sent;
      setRowState((prev) => {
        const next = { ...prev };
        for (const r of results) next[r.lecturerId] = r.status === "sent" ? "sent" : "idle";
        return next;
      });
      toast.success(
        `Queued for ${sent} lecturer${sent === 1 ? "" : "s"}${
          skipped > 0 ? ` · ${skipped} skipped (no phone / off)` : ""
        } — sending gradually (about one every 5 seconds). Check the Delivery Log.`
      );
      router.refresh();
    } catch (error) {
      toast.error(domainError(error) ?? getActionErrorMessage(error, "Could not send."));
    } finally {
      setBulkSending(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <CalendarCheck className="mt-0.5 size-5 text-muted-foreground" />
          <div className="text-sm">
            <p className="font-semibold">Send &ldquo;Timetable Ready&rdquo; to lecturers</p>
            <p className="text-muted-foreground">
              A lecturer-only WhatsApp for a semester level — &ldquo;your timetable is ready, view it
              at [domain]&rdquo;. No login details; completely separate from Lecturer Login
              Credentials. Students get nothing. Bulk sends are paced one message every 5 seconds.
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
          {blockedReason && <p className="text-xs text-amber-600">{blockedReason}</p>}

          {preview.lecturers.length === 0 ? (
            <p className="rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
              No lecturer has a built timetable at level {preview.semesterNumber} in{" "}
              {preview.semesterLabel} yet — nothing to notify.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  disabled={!canSend || bulkSending || preview.eligibleCount === 0}
                  onClick={sendAllEligible}
                >
                  {bulkSending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                  Send to all eligible ({preview.eligibleCount})
                </Button>
                <span className="text-xs text-muted-foreground">
                  Eligible = has a phone number and not yet sent for {preview.semesterLabel}. Sent
                  lecturers can be resent individually.
                </span>
              </div>

              <div className="max-h-72 overflow-auto rounded-lg border border-border">
                <Table>
                  <TableHeader className="sticky top-0 bg-card">
                    <TableRow>
                      <TableHead>Lecturer</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="w-44" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.lecturers.map((l, i) => {
                      const st = statusFor(l.lecturerId, l.notifiedAt);
                      return (
                        <TableRow key={l.lecturerId} className={i % 2 === 1 ? "bg-muted/30" : undefined}>
                          <TableCell className="font-medium">{l.fullName}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {!l.hasPhone
                              ? "No phone number"
                              : st === "sent" || l.notifiedAt
                                ? l.notifiedAt
                                  ? `Sent ${new Date(l.notifiedAt).toLocaleDateString()}`
                                  : "Sent"
                                : "Not sent"}
                          </TableCell>
                          <TableCell>
                            {!l.hasPhone ? (
                              <span className="text-xs text-muted-foreground">Set a phone first</span>
                            ) : !canSend ? (
                              <span className="text-xs text-muted-foreground">Unavailable</span>
                            ) : st === "sending" ? (
                              <Button variant="outline" size="sm" disabled>
                                <Loader2 className="size-3.5 animate-spin" />
                              </Button>
                            ) : st === "sent" || l.notifiedAt ? (
                              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                <Check className="size-3.5 text-green-600" />
                                <button
                                  type="button"
                                  className="underline hover:text-foreground"
                                  onClick={() => sendOne(l.lecturerId)}
                                >
                                  Resend
                                </button>
                              </span>
                            ) : (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => sendOne(l.lecturerId)}
                              >
                                <Send className="size-3.5" />
                                Send timetable ready
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
