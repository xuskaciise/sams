"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { Send } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { getActionErrorMessage } from "@/lib/action-error";
import { fillTemplate } from "@/lib/whatsapp-templates";
import type { SendNotificationData } from "./queries";
import {
  previewManualNotificationRecipients,
  sendManualNotification,
  type RecipientPreview,
} from "./actions";

type RecipientKind = "STUDENT" | "LECTURER";
type Target = "INDIVIDUAL" | "CLASS" | "FACULTY";

function PillRow<T extends string>({
  options,
  value,
  onChange,
  disabled,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((opt) => (
        <Button
          key={opt.value}
          type="button"
          size="sm"
          variant={value === opt.value ? "default" : "outline"}
          disabled={disabled}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </Button>
      ))}
    </div>
  );
}

export function SendNotificationClient({
  data,
  senderName,
}: {
  data: SendNotificationData;
  senderName: string;
}) {
  const { scope, templates, classes, departments, assignments, students, lecturers } = data;
  const isLecturerTier = scope.tier === "LECTURER";

  const [templateId, setTemplateId] = useState<string>(templates[0]?.id ?? "");
  const [recipientKind, setRecipientKind] = useState<RecipientKind>("STUDENT");
  const [target, setTarget] = useState<Target>("INDIVIDUAL");
  const [targetId, setTargetId] = useState<string>("");
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<RecipientPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isSending, startSending] = useTransition();

  const template = templates.find((t) => t.id === templateId);
  const usesMessage = template?.templateText.includes("{message}") ?? false;

  function targetOptionsFor(kind: RecipientKind): { value: Target; label: string }[] {
    const opts: { value: Target; label: string }[] = [{ value: "INDIVIDUAL", label: "Individual" }];
    if (kind === "STUDENT") {
      opts.push({ value: "CLASS", label: isLecturerTier ? "My course" : "Whole class" });
    }
    if (!isLecturerTier) {
      opts.push({ value: "FACULTY", label: "Whole faculty" });
    }
    return opts;
  }
  const targetOptions = targetOptionsFor(recipientKind);

  // Both handlers clear the now-stale target pick/preview directly,
  // rather than reacting to the change via a separate effect — a
  // recipientKind change can also invalidate the CURRENT target kind
  // (e.g. switching to "Lecturer(s)" while "Whole class" was selected),
  // so that's resolved here too, synchronously, instead of a second
  // effect chasing the first.
  function handleRecipientKindChange(next: RecipientKind) {
    setRecipientKind(next);
    const nextOptions = targetOptionsFor(next);
    if (!nextOptions.some((o) => o.value === target)) {
      setTarget(nextOptions[0]?.value ?? "INDIVIDUAL");
    }
    setTargetId("");
    setPreview(null);
  }

  function handleTargetChange(next: Target) {
    setTarget(next);
    setTargetId("");
    setPreview(null);
  }

  const targetPickerItems = useMemo(() => {
    if (target === "INDIVIDUAL") {
      return (recipientKind === "STUDENT" ? students : lecturers).map((o) => ({
        value: o.id,
        label: o.label,
        keywords: o.keywords,
      }));
    }
    if (target === "CLASS") {
      return (isLecturerTier ? assignments : classes).map((o) => ({ value: o.id, label: o.label }));
    }
    // FACULTY
    return departments.map((o) => ({ value: o.id, label: o.label }));
  }, [target, recipientKind, isLecturerTier, students, lecturers, classes, assignments, departments]);

  // Fetches a fresh recipient count/sample every time the pick changes —
  // a genuine data-fetching effect (subscribing to an external system,
  // the server action), so setPreview/setPreviewLoading here are the
  // intended pattern, same as the identical shape in
  // auto-timetable-generator-client.tsx's own preview-refetch effect.
  useEffect(() => {
    if (!targetId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing the stale preview for the now-empty pick, same pattern as build-timetable-client.tsx's setLoadingSlots
      setPreview(null);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    previewManualNotificationRecipients({ recipientKind, target, targetId })
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch((error) => {
        if (!cancelled) {
          setPreview(null);
          toast.error(getActionErrorMessage(error, "Could not resolve recipients."));
        }
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [recipientKind, target, targetId]);

  const targetLabel = targetPickerItems.find((i) => i.value === targetId)?.label ?? "";
  const messagePreview = template
    ? fillTemplate(template.templateText, {
        recipientName: "(recipient's name)",
        senderName,
        className: target === "CLASS" ? targetLabel : "",
        facultyName: target === "FACULTY" ? targetLabel : "",
        date: new Date().toISOString().slice(0, 10),
        message: message || "(your message)",
      })
    : "";

  const canSend =
    !!templateId && !!targetId && (!usesMessage || message.trim().length > 0) && !isSending;

  function handleSend() {
    startSending(async () => {
      try {
        const result = await sendManualNotification({
          templateId,
          recipientKind,
          target,
          targetId,
          message,
        });
        toast.success(
          `Sent to ${result.enqueued} recipient${result.enqueued === 1 ? "" : "s"}` +
            (result.skippedNoPhoneOrDisabled > 0
              ? ` (${result.skippedNoPhoneOrDisabled} skipped — no phone on file, or WhatsApp is off)`
              : ".")
        );
        setConfirmOpen(false);
        setTargetId("");
        setMessage("");
        setPreview(null);
      } catch (error) {
        toast.error(getActionErrorMessage(error, "Could not send this notification."));
      }
    });
  }

  if (templates.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Send Notification"
          description="Send an ad-hoc WhatsApp notification using a manual template."
        />
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No manual notification types exist yet. Ask an admin to create one from Notification
            Templates (WhatsApp &gt; Notification Templates &gt; Create new event type).
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Send Notification"
        description={
          isLecturerTier
            ? "Send an ad-hoc WhatsApp notification to your own students."
            : "Send an ad-hoc WhatsApp notification using a manual template."
        }
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-semibold">Compose</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">Template</label>
              <SearchableSelect
                value={templateId}
                onValueChange={setTemplateId}
                items={templates.map((t) => ({ value: t.id, label: t.name }))}
                placeholder="Select a notification type…"
              />
              {template?.description && (
                <p className="text-xs text-muted-foreground">{template.description}</p>
              )}
            </div>

            {!isLecturerTier && (
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">Who</label>
                <PillRow
                  options={[
                    { value: "STUDENT", label: "Student(s)" },
                    { value: "LECTURER", label: "Lecturer(s)" },
                  ]}
                  value={recipientKind}
                  onChange={handleRecipientKindChange}
                />
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">Scope</label>
              <PillRow options={targetOptions} value={target} onChange={handleTargetChange} />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">
                {target === "INDIVIDUAL"
                  ? recipientKind === "STUDENT"
                    ? "Student"
                    : "Lecturer"
                  : target === "CLASS"
                    ? isLecturerTier
                      ? "My course"
                      : "Class"
                    : "Faculty"}
              </label>
              {targetPickerItems.length === 0 ? (
                <p className="rounded-md border border-dashed border-border bg-muted/20 p-3 text-xs text-muted-foreground">
                  {isLecturerTier
                    ? "You have no course assignments yet, or no students enrolled in them."
                    : "Nothing available to pick — check faculty scoping if this seems wrong."}
                </p>
              ) : (
                <SearchableSelect
                  value={targetId}
                  onValueChange={setTargetId}
                  items={targetPickerItems}
                  placeholder="Search…"
                />
              )}
            </div>

            {usesMessage && (
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">
                  Message <span className="text-destructive">*</span>
                </label>
                <Textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={3}
                  placeholder="e.g. Submit Assignment 3 by Friday 5pm."
                />
              </div>
            )}

            <div className="flex items-center justify-between rounded-md border border-border bg-muted/20 px-3 py-2 text-sm">
              <span className="text-muted-foreground">Recipients</span>
              <span className="font-medium">
                {!targetId
                  ? "—"
                  : previewLoading
                    ? "Resolving…"
                    : preview
                      ? `${preview.count} recipient${preview.count === 1 ? "" : "s"}${
                          preview.skippedNoPhone > 0 ? ` (${preview.skippedNoPhone} without a phone number)` : ""
                        }`
                      : "—"}
              </span>
            </div>
          </CardContent>
          <CardFooter className="justify-end">
            <Button type="button" disabled={!canSend} onClick={() => setConfirmOpen(true)}>
              <Send className="size-3.5" />
              Send Notification
            </Button>
          </CardFooter>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base font-semibold">Preview</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="rounded-lg border border-dashed border-border bg-muted/20 p-3">
              <p className="mb-1 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Sample message
              </p>
              <p className="text-sm whitespace-pre-wrap">
                {messagePreview || "Pick a template to see a preview."}
              </p>
            </div>
            {preview && preview.sample.length > 0 && (
              <div>
                <p className="mb-1 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Will be sent to
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {preview.sample.map((r, i) => (
                    <Badge key={i} variant="outline">
                      {r.name}
                    </Badge>
                  ))}
                  {preview.truncated && (
                    <Badge variant="outline">and {preview.count - preview.sample.length} more</Badge>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send this notification?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will send &ldquo;{template?.name}&rdquo; to{" "}
            <span className="font-medium text-foreground">
              {preview?.count ?? 0} recipient{(preview?.count ?? 0) === 1 ? "" : "s"}
            </span>
            . This can&rsquo;t be undone.
          </p>
          <div className="rounded-lg border border-dashed border-border bg-muted/20 p-3">
            <p className="text-sm whitespace-pre-wrap">{messagePreview}</p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button type="button" disabled={isSending} onClick={handleSend}>
              {isSending ? "Sending…" : "Confirm & Send"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
