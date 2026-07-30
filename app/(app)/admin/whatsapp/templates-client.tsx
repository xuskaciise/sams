"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RotateCcw, Save } from "lucide-react";
import type { WhatsAppEventType, WhatsAppMessageTemplate } from "@prisma/client";
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { getActionErrorMessage } from "@/lib/action-error";
import {
  WHATSAPP_TEMPLATE_PLACEHOLDERS,
  WHATSAPP_EVENT_TYPE_LABELS,
  DEFAULT_WHATSAPP_TEMPLATES,
  findUnknownPlaceholders,
  fillTemplate,
} from "@/lib/whatsapp-templates";
import { updateWhatsAppTemplate, resetWhatsAppTemplate } from "./actions";

// Fixed display order — not derived from the DB rows, so a row that
// somehow doesn't exist yet still gets a card (defaulting to the seeded
// text) instead of silently disappearing from the list.
const EVENT_TYPES: WhatsAppEventType[] = ["RESULTS_PUBLISHED", "LEAVE_NOTICE", "TIMETABLE_CHANGE"];

// Sample values for the live preview only — never sent anywhere. Covers
// every placeholder each event type supports, so switching text between
// them always renders a fully-filled preview with nothing left as a
// literal {token}.
const PREVIEW_SAMPLE: Record<WhatsAppEventType, Record<string, string>> = {
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
};

type TemplateRow = WhatsAppMessageTemplate & { updatedByUser: { fullName: string } | null };

function TemplateCard({
  eventType,
  row,
  canManage,
}: {
  eventType: WhatsAppEventType;
  row: TemplateRow | undefined;
  canManage: boolean;
}) {
  const router = useRouter();
  const initialText = row?.templateText ?? DEFAULT_WHATSAPP_TEMPLATES[eventType];
  const [text, setText] = useState(initialText);
  const [isPending, startTransition] = useTransition();
  const [isResetting, setIsResetting] = useState(false);

  const placeholders = WHATSAPP_TEMPLATE_PLACEHOLDERS[eventType];
  const unknown = findUnknownPlaceholders(eventType, text);
  const isEmpty = text.trim().length === 0;
  const isDefault = text === DEFAULT_WHATSAPP_TEMPLATES[eventType];
  const isDirty = text !== initialText;
  const preview = fillTemplate(text, PREVIEW_SAMPLE[eventType]);

  function handleSave() {
    startTransition(async () => {
      try {
        await updateWhatsAppTemplate(eventType, text);
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
      await resetWhatsAppTemplate(eventType);
      setText(DEFAULT_WHATSAPP_TEMPLATES[eventType]);
      toast.success("Reset to default wording.");
      router.refresh();
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not reset this template."));
    } finally {
      setIsResetting(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-base font-semibold">
            {WHATSAPP_EVENT_TYPE_LABELS[eventType]}
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            {row?.updatedByUser
              ? `Last edited by ${row.updatedByUser.fullName} on ${row.updatedAt.toLocaleString()}`
              : "Using the default wording — never edited."}
          </p>
        </div>
        {isDefault && <Badge variant="outline">Default</Badge>}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-1.5">
          {placeholders.map((p) => (
            <button
              key={p}
              type="button"
              disabled={!canManage}
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
          disabled={!canManage}
          rows={4}
          className="font-mono text-sm"
        />

        {unknown.length > 0 && (
          <p className="text-xs text-destructive">
            Unknown placeholder{unknown.length > 1 ? "s" : ""}:{" "}
            {unknown.map((p) => `{${p}}`).join(", ")} — not available for{" "}
            {WHATSAPP_EVENT_TYPE_LABELS[eventType]}.
          </p>
        )}

        <div className="rounded-lg border border-dashed border-border bg-muted/20 p-3">
          <p className="mb-1 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Preview
          </p>
          <p className="text-sm whitespace-pre-wrap">{preview}</p>
        </div>
      </CardContent>
      {canManage && (
        <CardFooter className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isResetting || isDefault}
            onClick={handleReset}
          >
            <RotateCcw className="size-3.5" />
            Reset to default
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={isPending || isEmpty || unknown.length > 0 || !isDirty}
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

export function TemplatesClient({
  templates,
  canManage,
}: {
  templates: TemplateRow[];
  canManage: boolean;
}) {
  const byEventType = new Map(templates.map((t) => [t.eventType, t]));

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Customize the wording sent for each notification trigger. Use the placeholder buttons
        below each textarea to insert a value that gets filled in per recipient — the preview
        shows what a real message would look like.
        {!canManage && " You don't have permission to edit these — showing the current wording read-only."}
      </p>

      <div className="flex flex-col gap-4">
        {EVENT_TYPES.map((eventType) => (
          <TemplateCard
            key={`${eventType}:${byEventType.get(eventType)?.templateText ?? ""}`}
            eventType={eventType}
            row={byEventType.get(eventType)}
            canManage={canManage}
          />
        ))}
      </div>
    </div>
  );
}
