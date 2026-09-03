"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RotateCcw, Save, Plus, Ban, Undo2 } from "lucide-react";
import type { WhatsAppMessageTemplate, WhatsAppTriggerKind } from "@prisma/client";
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
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
  AUTOMATIC_EVENTS,
  MANUAL_TEMPLATE_PLACEHOLDERS,
  channelFor,
  placeholdersFor,
  findUnknownPlaceholders,
  fillTemplate,
} from "@/lib/whatsapp-templates";
import {
  updateWhatsAppTemplate,
  resetWhatsAppTemplate,
  createWhatsAppTemplate,
  deactivateWhatsAppTemplate,
  reactivateWhatsAppTemplate,
} from "./actions";

type TemplateRow = WhatsAppMessageTemplate & { updatedByUser: { fullName: string } | null };

// Sample values for the live preview only — never sent anywhere. Every
// AUTOMATIC placeholder gets a sample here; a MANUAL template's preview
// uses PREVIEW_SAMPLE_MANUAL instead (see below) since its placeholder
// set is fixed and shared regardless of which template it is.
const PREVIEW_SAMPLE_AUTOMATIC: Record<string, Record<string, string>> = {
  RESULTS_PUBLISHED: {
    studentName: "Amina Yusuf",
    courseName: "Database Systems",
    assessmentTitle: "Quiz 1",
    className: "CMS26-A-FT",
    semesterName: "Semester 1",
    mark: "18",
  },
  LEAVE_NOTICE: {
    recipientName: "Dr. Ahmed Ali",
    title: "Leave notice — Dr. Ahmed Ali",
    date: "2026-07-30",
    description: " — Sick leave for 3 days",
  },
  TIMETABLE_CHANGE: {
    studentName: "Amina Yusuf",
    className: "CMS26-A-FT",
    changeSummary: "a session was added on Saturday 09:00-10:00",
  },
  STUDENT_LOGIN_CREDENTIALS_EMAIL: {
    studentName: "Amina Yusuf",
    studentNo: "S1001",
    username: "S1001",
    tempPassword: "Xk7-mQ2p",
    domainName: "sams.example.edu",
  },
  RESULTS_PUBLISHED_EMAIL: {
    studentName: "Amina Yusuf",
    courseName: "Database Systems",
    assessmentTitle: "Quiz 1",
    className: "CMS26-A-FT",
    semesterName: "Semester 1",
    domainName: "sams.example.edu",
  },
};

const PREVIEW_SAMPLE_MANUAL: Record<string, string> = {
  recipientName: "Amina Yusuf",
  senderName: "Admin Zahra",
  className: "CMS26-A-FT",
  facultyName: "Faculty of Computing",
  date: "2026-08-26",
  message: "No classes on Thursday — public holiday.",
};

function TemplateCard({ row, canManage }: { row: TemplateRow; canManage: boolean }) {
  const router = useRouter();
  const def = AUTOMATIC_EVENTS[row.eventKey];
  const isAutomatic = row.triggerKind === "AUTOMATIC";
  const isEmail = channelFor(row.eventKey) === "EMAIL";
  const [text, setText] = useState(row.templateText);
  const [subject, setSubject] = useState(row.subject ?? "");
  const [isPending, startTransition] = useTransition();
  const [isResetting, setIsResetting] = useState(false);
  const [isTogglingActive, setIsTogglingActive] = useState(false);

  const placeholders = placeholdersFor(row.triggerKind, row.eventKey);
  const unknown = findUnknownPlaceholders(row.triggerKind, row.eventKey, text);
  const subjectUnknown = isEmail
    ? findUnknownPlaceholders(row.triggerKind, row.eventKey, subject)
    : [];
  const isEmpty = text.trim().length === 0;
  const subjectEmpty = isEmail && subject.trim().length === 0;
  const isDefault =
    isAutomatic && def
      ? text === def.defaultTemplateText &&
        (!isEmail || subject === (def.defaultSubject ?? ""))
      : false;
  const isDirty = text !== row.templateText || (isEmail && subject !== (row.subject ?? ""));
  const previewVars = isAutomatic
    ? (PREVIEW_SAMPLE_AUTOMATIC[row.eventKey] ?? {})
    : PREVIEW_SAMPLE_MANUAL;
  const preview = fillTemplate(text, previewVars);
  const subjectPreview = isEmail ? fillTemplate(subject, previewVars) : "";
  const isDeactivated = row.deletedAt !== null;

  function handleSave() {
    startTransition(async () => {
      try {
        await updateWhatsAppTemplate(row.eventKey, text, isEmail ? subject : undefined);
        toast.success("Template saved.");
        router.refresh();
      } catch (error) {
        toast.error(getActionErrorMessage(error, "Could not save this template."));
      }
    });
  }

  async function handleReset() {
    setIsResetting(true);
    try {
      await resetWhatsAppTemplate(row.eventKey);
      if (def) {
        setText(def.defaultTemplateText);
        if (isEmail) setSubject(def.defaultSubject ?? "");
      }
      toast.success("Reset to default wording.");
      router.refresh();
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not reset this template."));
    } finally {
      setIsResetting(false);
    }
  }

  async function handleToggleActive() {
    setIsTogglingActive(true);
    try {
      if (isDeactivated) {
        await reactivateWhatsAppTemplate(row.id);
        toast.success("Reactivated — available for Send Notification again.");
      } else {
        await deactivateWhatsAppTemplate(row.id);
        toast.success("Deactivated — no longer offered for new sends.");
      }
      router.refresh();
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not update this notification type."));
    } finally {
      setIsTogglingActive(false);
    }
  }

  return (
    <Card className={isDeactivated ? "opacity-70" : undefined}>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-base font-semibold">{row.name}</CardTitle>
          {row.description && (
            <p className="mt-0.5 text-xs text-muted-foreground">{row.description}</p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            {row.updatedByUser
              ? `Last edited by ${row.updatedByUser.fullName} on ${row.updatedAt.toLocaleString()}`
              : "Using the default wording — never edited."}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {isEmail && <Badge variant="outline">Email</Badge>}
          {isDefault && <Badge variant="outline">Default</Badge>}
          {isDeactivated && <Badge variant="destructive">Deactivated</Badge>}
          {!isAutomatic && <Badge variant="outline">Manual</Badge>}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {isEmail && (
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Subject
            </label>
            <Input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              disabled={!canManage || isDeactivated}
              className="text-sm"
            />
            {subjectUnknown.length > 0 && (
              <p className="text-xs text-destructive">
                Unknown placeholder{subjectUnknown.length > 1 ? "s" : ""} in subject:{" "}
                {subjectUnknown.map((p) => `{${p}}`).join(", ")}
              </p>
            )}
          </div>
        )}
        <div className="flex flex-wrap gap-1.5">
          {placeholders.map((p) => (
            <button
              key={p}
              type="button"
              disabled={!canManage || isDeactivated}
              onClick={() => setText((prev) => `${prev}{${p}}`)}
              className="rounded-full border border-border bg-muted/40 px-2 py-0.5 font-mono text-xs text-muted-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
              title={canManage ? "Click to insert at the end" : undefined}
            >
              {`{${p}}`}
            </button>
          ))}
        </div>

        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={!canManage || isDeactivated}
          rows={4}
          className="font-mono text-sm"
        />

        {unknown.length > 0 && (
          <p className="text-xs text-destructive">
            Unknown placeholder{unknown.length > 1 ? "s" : ""}:{" "}
            {unknown.map((p) => `{${p}}`).join(", ")} — not available for {row.name}.
          </p>
        )}

        <div className="rounded-lg border border-dashed border-border bg-muted/20 p-3">
          <p className="mb-1 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Preview
          </p>
          {isEmail && (
            <p className="mb-1 text-sm font-semibold">
              Subject: <span className="font-normal">{subjectPreview}</span>
            </p>
          )}
          <p className="text-sm whitespace-pre-wrap">{preview}</p>
        </div>
      </CardContent>
      {canManage && (
        <CardFooter className="flex flex-wrap justify-end gap-2">
          {!row.isSystem && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isTogglingActive}
              onClick={handleToggleActive}
            >
              {isDeactivated ? (
                <>
                  <Undo2 className="size-3.5" />
                  Reactivate
                </>
              ) : (
                <>
                  <Ban className="size-3.5" />
                  Deactivate
                </>
              )}
            </Button>
          )}
          {isAutomatic && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isResetting || isDefault || isDeactivated}
              onClick={handleReset}
            >
              <RotateCcw className="size-3.5" />
              Reset to default
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            disabled={
              isPending ||
              isEmpty ||
              subjectEmpty ||
              unknown.length > 0 ||
              subjectUnknown.length > 0 ||
              !isDirty ||
              isDeactivated
            }
            onClick={handleSave}
          >
            <Save className="size-3.5" />
            Save
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}

function CreateEventTypeDialog({
  availableAutomaticKeys,
  onCreated,
}: {
  availableAutomaticKeys: string[];
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [triggerKind, setTriggerKind] = useState<WhatsAppTriggerKind>("MANUAL");
  const [eventKey, setEventKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [templateText, setTemplateText] = useState("");
  const [isPending, startTransition] = useTransition();

  const isAutomatic = triggerKind === "AUTOMATIC";
  const automaticDef = isAutomatic ? AUTOMATIC_EVENTS[eventKey] : undefined;
  const placeholders = isAutomatic
    ? (automaticDef?.placeholders ?? [])
    : MANUAL_TEMPLATE_PLACEHOLDERS;
  const unknown = isAutomatic
    ? eventKey
      ? findUnknownPlaceholders("AUTOMATIC", eventKey, templateText)
      : []
    : findUnknownPlaceholders("MANUAL", "PREVIEW", templateText);

  function reset() {
    setTriggerKind("MANUAL");
    setEventKey("");
    setName("");
    setDescription("");
    setTemplateText("");
  }

  function handleCreate() {
    startTransition(async () => {
      try {
        await createWhatsAppTemplate({
          triggerKind,
          eventKey: isAutomatic ? eventKey : undefined,
          name: name.trim() || undefined,
          description: description.trim() || undefined,
          templateText,
        });
        toast.success("Notification type created.");
        setOpen(false);
        reset();
        onCreated();
      } catch (error) {
        toast.error(getActionErrorMessage(error, "Could not create this notification type."));
      }
    });
  }

  const canSubmit =
    templateText.trim().length > 0 &&
    unknown.length === 0 &&
    (isAutomatic ? !!eventKey : name.trim().length > 0);

  return (
    <>
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        <Plus className="size-3.5" />
        Create new event type
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
      >
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create notification event type</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Trigger kind</label>
            <Select
              value={triggerKind}
              onValueChange={(v) => {
                setTriggerKind(v as WhatsAppTriggerKind);
                setEventKey("");
                setTemplateText("");
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="MANUAL">Manual — sent on demand via Send Notification</SelectItem>
                <SelectItem value="AUTOMATIC">
                  Automatic — tied to an existing system event
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {isAutomatic ? (
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">Which existing event hook?</label>
              {availableAutomaticKeys.length === 0 ? (
                <p className="rounded-md border border-dashed border-border bg-muted/20 p-3 text-xs text-muted-foreground">
                  Every automatic hook currently in the code already has a template — there&rsquo;s
                  nothing new to register. A new automatic type only becomes available here once a
                  new hook is added to the codebase.
                </p>
              ) : (
                <Select
                  value={eventKey}
                  onValueChange={(v) => {
                    const key = v ?? "";
                    setEventKey(key);
                    setName(AUTOMATIC_EVENTS[key]?.label ?? "");
                    setTemplateText(AUTOMATIC_EVENTS[key]?.defaultTemplateText ?? "");
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select a hook…" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableAutomaticKeys.map((key) => (
                      <SelectItem key={key} value={key}>
                        {AUTOMATIC_EVENTS[key].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {automaticDef && (
                <p className="text-xs text-muted-foreground">{automaticDef.description}</p>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              A manual type has no code hook — it&rsquo;s only ever sent when someone with the
              &ldquo;Send Notification&rdquo; permission deliberately sends it.
            </p>
          )}

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">
              Name {!isAutomatic && <span className="text-destructive">*</span>}
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={isAutomatic ? "Defaults to the hook's own label" : "e.g. University Holiday"}
              maxLength={120}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Description (optional)</label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Shown to whoever picks this template"
              maxLength={500}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Template text</label>
            <div className="flex flex-wrap gap-1.5">
              {placeholders.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setTemplateText((prev) => `${prev}{${p}}`)}
                  className="rounded-full border border-border bg-muted/40 px-2 py-0.5 font-mono text-xs text-muted-foreground hover:bg-muted"
                >
                  {`{${p}}`}
                </button>
              ))}
            </div>
            <Textarea
              value={templateText}
              onChange={(e) => setTemplateText(e.target.value)}
              rows={4}
              className="font-mono text-sm"
              placeholder={isAutomatic ? "e.g. Hello {studentName}, ..." : "e.g. Hi {recipientName}, {message}"}
            />
            {unknown.length > 0 && (
              <p className="text-xs text-destructive">
                Unknown placeholder{unknown.length > 1 ? "s" : ""}:{" "}
                {unknown.map((p) => `{${p}}`).join(", ")}
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={!canSubmit || isPending} onClick={handleCreate}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
      </Dialog>
    </>
  );
}

export function TemplatesClient({
  templates,
  availableAutomaticKeys,
  canManage,
}: {
  templates: TemplateRow[];
  availableAutomaticKeys: string[];
  canManage: boolean;
}) {
  const router = useRouter();
  const automatic = templates.filter((t) => t.triggerKind === "AUTOMATIC");
  const manual = templates.filter((t) => t.triggerKind === "MANUAL");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Customize the wording sent for each notification event. Use the placeholder buttons below
          each textarea to insert a value that gets filled in per recipient — the preview shows what
          a real message would look like.
          {!canManage && " You don't have permission to edit these — showing the current wording read-only."}
        </p>
        {canManage && (
          <CreateEventTypeDialog
            availableAutomaticKeys={availableAutomaticKeys}
            onCreated={() => router.refresh()}
          />
        )}
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Automatic — tied to a system event
        </h3>
        <div className="flex flex-col gap-4">
          {automatic.map((row) => (
            <TemplateCard
              key={`${row.eventKey}:${row.templateText}:${row.subject ?? ""}`}
              row={row}
              canManage={canManage}
            />
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Manual — sent on demand
        </h3>
        {manual.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border bg-muted/20 p-4 text-sm text-muted-foreground">
            No manual notification types yet. Create one above (e.g. &ldquo;University
            Holiday&rdquo;) to make it available on the Send Notification page.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {manual.map((row) => (
              <TemplateCard
                key={`${row.eventKey}:${row.templateText}:${row.deletedAt ?? ""}`}
                row={row}
                canManage={canManage}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
