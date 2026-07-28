"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import type { Campus } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { getActionErrorMessage } from "@/lib/action-error";
import type { BulkRoomRow } from "./schema";
import { generateRoomRange } from "./range-generator";
import { previewBulkRooms, bulkCreateRooms, type BulkRoomPreviewRow } from "./actions";

const STATUS_LABEL: Record<BulkRoomPreviewRow["status"], string> = {
  OK: "OK",
  DUPLICATE_IN_BATCH: "Duplicate in list",
  ALREADY_EXISTS: "Already exists",
};

const STATUS_VARIANT: Record<
  BulkRoomPreviewRow["status"],
  "published" | "draft" | "outline"
> = {
  OK: "published",
  DUPLICATE_IN_BATCH: "draft",
  ALREADY_EXISTS: "outline",
};

type Step = "input" | "preview";

function parsePastedList(text: string): BulkRoomRow[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((name) => ({ name }));
}

export function BulkAddRoomsDialog({
  open,
  onOpenChange,
  campuses,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  campuses: Campus[];
  onDone: () => void;
}) {
  const [step, setStep] = useState<Step>("input");
  const [campusId, setCampusId] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [prefix, setPrefix] = useState("");
  const [startText, setStartText] = useState("");
  const [endText, setEndText] = useState("");
  const [rangeCapacity, setRangeCapacity] = useState<number | undefined>(undefined);
  const [previewRows, setPreviewRows] = useState<BulkRoomPreviewRow[]>([]);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [confirming, setConfirming] = useState(false);

  function reset() {
    setStep("input");
    setCampusId("");
    setPasteText("");
    setPrefix("");
    setStartText("");
    setEndText("");
    setRangeCapacity(undefined);
    setPreviewRows([]);
    setLoadingPreview(false);
    setConfirming(false);
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function previewRows_(rows: BulkRoomRow[]) {
    if (!campusId) {
      toast.error("Select a campus first.");
      return;
    }
    if (rows.length === 0) {
      toast.error("Add at least one room first.");
      return;
    }
    setLoadingPreview(true);
    try {
      const result = await previewBulkRooms(campusId, rows);
      setPreviewRows(result);
      setStep("preview");
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not preview these rooms."));
    } finally {
      setLoadingPreview(false);
    }
  }

  function handlePreviewPaste() {
    previewRows_(parsePastedList(pasteText));
  }

  function handlePreviewRange() {
    const result = generateRoomRange({ prefix, startText, endText });
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    previewRows_(result.names.map((name) => ({ name, capacity: rangeCapacity })));
  }

  async function handleConfirm() {
    const okRows = previewRows
      .filter((r) => r.status === "OK")
      .map(({ name, capacity }) => ({ name, capacity }));
    if (okRows.length === 0 || !campusId) return;

    setConfirming(true);
    try {
      const result = await bulkCreateRooms(campusId, okRows);
      toast.success(
        `${result.created} room${result.created === 1 ? "" : "s"} created${
          result.skipped > 0 ? `, ${result.skipped} skipped` : ""
        }.`
      );
      handleOpenChange(false);
      onDone();
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Bulk create failed. Please try again."));
    } finally {
      setConfirming(false);
    }
  }

  const okCount = previewRows.filter((r) => r.status === "OK").length;
  const duplicateCount = previewRows.filter((r) => r.status === "DUPLICATE_IN_BATCH").length;
  const existsCount = previewRows.filter((r) => r.status === "ALREADY_EXISTS").length;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Bulk add rooms</DialogTitle>
          <DialogDescription>
            Paste a list of room names, or generate a numbered range.
          </DialogDescription>
        </DialogHeader>

        {step === "input" && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">
                Campus <span className="text-muted-foreground">(applies to every room in this batch)</span>
              </label>
              <SearchableSelect
                value={campusId}
                onValueChange={setCampusId}
                items={campuses.map((c) => ({ value: c.id, label: c.name }))}
                placeholder="Select a campus"
                searchPlaceholder="Search campuses…"
                emptyMessage="No campuses yet — add one in the Campuses tab first."
                className="w-full"
              />
            </div>

            <Tabs defaultValue="paste">
            <TabsList>
              <TabsTrigger value="paste">Paste list</TabsTrigger>
              <TabsTrigger value="range">Number range</TabsTrigger>
            </TabsList>

            <TabsContent value="paste" className="flex flex-col gap-3 pt-4">
              <Textarea
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder={"Room 101\nLab 2\nHall A"}
                rows={8}
              />
              <p className="text-xs text-muted-foreground">One room name per line.</p>
              <Button
                type="button"
                onClick={handlePreviewPaste}
                disabled={loadingPreview}
                className="self-end"
              >
                {loadingPreview && <Loader2 className="size-4 animate-spin" />}
                Preview
              </Button>
            </TabsContent>

            <TabsContent value="range" className="flex flex-col gap-3 pt-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2 flex flex-col gap-1.5">
                  <label className="text-sm font-medium">Prefix</label>
                  <Input
                    value={prefix}
                    onChange={(e) => setPrefix(e.target.value)}
                    placeholder="e.g. Room 1"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium">Start number</label>
                  <Input
                    value={startText}
                    onChange={(e) => setStartText(e.target.value)}
                    placeholder="e.g. 01"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium">End number</label>
                  <Input
                    value={endText}
                    onChange={(e) => setEndText(e.target.value)}
                    placeholder="e.g. 20"
                  />
                </div>
                <div className="col-span-2 flex flex-col gap-1.5">
                  <label className="text-sm font-medium">Capacity (optional, applies to all)</label>
                  <Input
                    type="number"
                    value={rangeCapacity ?? ""}
                    onChange={(e) =>
                      setRangeCapacity(e.target.value ? Number(e.target.value) : undefined)
                    }
                    placeholder="e.g. 40"
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                e.g. prefix &ldquo;Room 1&rdquo;, 01 to 20 &rarr; &ldquo;Room 101&rdquo; .. &ldquo;Room 120&rdquo;.
                Leading zeros in the start number set the padding width.
              </p>
              <Button
                type="button"
                onClick={handlePreviewRange}
                disabled={loadingPreview}
                className="self-end"
              >
                {loadingPreview && <Loader2 className="size-4 animate-spin" />}
                Preview
              </Button>
            </TabsContent>
            </Tabs>
          </div>
        )}

        {step === "preview" && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">
                Campus: <span className="font-medium text-foreground">
                  {campuses.find((c) => c.id === campusId)?.name}
                </span>
              </span>
              <div className="ml-auto flex flex-wrap gap-2">
                <Badge variant="published">{okCount} ok</Badge>
                <Badge variant="draft">{duplicateCount} duplicate</Badge>
                <Badge variant="outline">{existsCount} already exists</Badge>
              </div>
            </div>

            <div className="max-h-80 overflow-auto rounded-lg border border-border">
              <Table>
                <TableHeader className="sticky top-0 bg-card">
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead className="text-right">Capacity</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {previewRows.map((row, i) => (
                    <TableRow key={i} className={i % 2 === 1 ? "bg-muted/30" : undefined}>
                      <TableCell className="font-medium">{row.name}</TableCell>
                      <TableCell className="text-right">{row.capacity ?? "—"}</TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANT[row.status]}>
                          {STATUS_LABEL[row.status]}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setStep("input");
                  setPreviewRows([]);
                }}
              >
                Back
              </Button>
              <Button type="button" onClick={handleConfirm} disabled={confirming || okCount === 0}>
                {confirming && <Loader2 className="size-4 animate-spin" />}
                Create {okCount} room{okCount === 1 ? "" : "s"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
