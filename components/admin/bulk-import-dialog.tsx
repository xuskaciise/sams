"use client";

import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { Loader2, Upload, Download, FileSpreadsheet } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { getActionErrorMessage } from "@/lib/action-error";
import { downloadBase64 } from "@/lib/download";
import type {
  BulkImportColumn,
  ImportPreviewResult,
  ImportRowResult,
} from "@/lib/import/types";

const STATUS_LABEL: Record<ImportRowResult<unknown>["status"], string> = {
  OK: "OK",
  DUPLICATE_IN_FILE: "Duplicate in file",
  ALREADY_EXISTS: "Already exists",
  ERROR: "Error",
};

const STATUS_VARIANT: Record<
  ImportRowResult<unknown>["status"],
  "published" | "draft" | "outline" | "destructive"
> = {
  OK: "published",
  DUPLICATE_IN_FILE: "draft",
  ALREADY_EXISTS: "outline",
  ERROR: "destructive",
};

type Step = "upload" | "preview";

interface BulkImportDialogProps<T> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  columns: BulkImportColumn[];
  onDownloadTemplate: () => Promise<{ base64: string; fileName: string }>;
  onPreview: (formData: FormData) => Promise<ImportPreviewResult<T>>;
  onConfirm: (rows: T[], fileName: string) => Promise<unknown>;
  // When provided, replaces the default success toast+close with a custom
  // result screen (e.g. lecturer import's shown-once temp password list).
  renderConfirmResult?: (result: unknown, onDone: () => void) => ReactNode;
}

export function BulkImportDialog<T>({
  open,
  onOpenChange,
  title,
  description,
  columns,
  onDownloadTemplate,
  onPreview,
  onConfirm,
  renderConfirmResult,
}: BulkImportDialogProps<T>) {
  const [step, setStep] = useState<Step>("upload");
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<ImportPreviewResult<T> | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmResult, setConfirmResult] = useState<unknown>(null);
  const [downloadingTemplate, setDownloadingTemplate] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function reset() {
    setStep("upload");
    setDragging(false);
    setFileName(null);
    setUploading(false);
    setPreview(null);
    setConfirming(false);
    setConfirmResult(null);
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function handleTemplate() {
    setDownloadingTemplate(true);
    try {
      const { base64, fileName: templateFileName } = await onDownloadTemplate();
      downloadBase64(
        base64,
        templateFileName,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not build the template."));
    } finally {
      setDownloadingTemplate(false);
    }
  }

  async function handleFile(file: File) {
    setFileName(file.name);
    setUploading(true);
    try {
      const formData = new FormData();
      formData.set("file", file);
      const result = await onPreview(formData);
      setPreview(result);
      setStep("preview");
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not read that file."));
      setFileName(null);
    } finally {
      setUploading(false);
    }
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  }

  async function handleConfirm() {
    if (!preview) return;
    const okRows = preview.rows
      .filter((r) => r.status === "OK" && r.data !== null)
      .map((r) => r.data as T);
    if (okRows.length === 0) return;

    setConfirming(true);
    try {
      const result = await onConfirm(okRows, fileName ?? "");
      if (renderConfirmResult) {
        setConfirmResult(result);
      } else {
        toast.success(
          `Imported ${okRows.length} row${okRows.length === 1 ? "" : "s"}.`
        );
        handleOpenChange(false);
      }
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Import failed. Please try again."));
    } finally {
      setConfirming(false);
    }
  }

  if (confirmResult && renderConfirmResult) {
    return (
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-2xl">
          {renderConfirmResult(confirmResult, () => handleOpenChange(false))}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {step === "upload" && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col items-start justify-between gap-3 rounded-lg border border-border bg-muted/30 p-3 sm:flex-row sm:items-center">
              <div className="text-sm">
                <p className="font-medium">1. Download the template</p>
                <p className="text-muted-foreground">
                  Expected columns: {columns.map((c) => c.label).join(", ")}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={handleTemplate}
                disabled={downloadingTemplate}
              >
                {downloadingTemplate ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Download className="size-4" />
                )}
                Download template
              </Button>
            </div>

            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              onClick={() => inputRef.current?.click()}
              className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-10 text-center transition-colors ${
                dragging
                  ? "border-primary bg-primary/5"
                  : "border-border hover:bg-muted/30"
              }`}
            >
              {uploading ? (
                <Loader2 className="size-8 animate-spin text-muted-foreground" />
              ) : (
                <Upload className="size-8 text-muted-foreground" />
              )}
              <p className="text-sm font-medium">
                {fileName ??
                  "2. Drop your .xlsx or .csv file here, or click to browse"}
              </p>
              <p className="text-xs text-muted-foreground">Max 5MB, 2000 rows</p>
              <input
                ref={inputRef}
                type="file"
                accept=".xlsx,.csv"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFile(file);
                  e.target.value = "";
                }}
              />
            </div>
          </div>
        )}

        {step === "preview" && preview && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <FileSpreadsheet className="size-4 text-muted-foreground" />
              <span className="font-medium">{fileName}</span>
              <div className="ml-auto flex flex-wrap gap-2">
                <Badge variant="published">{preview.counts.ok} ok</Badge>
                <Badge variant="draft">
                  {preview.counts.duplicate} duplicate
                </Badge>
                <Badge variant="outline">
                  {preview.counts.alreadyExists} skipped
                </Badge>
                <Badge variant="destructive">{preview.counts.error} error</Badge>
              </div>
            </div>

            <div className="max-h-96 overflow-auto rounded-lg border border-border">
              <Table>
                <TableHeader className="sticky top-0 bg-card">
                  <TableRow>
                    <TableHead className="w-12">Row</TableHead>
                    {columns.map((c) => (
                      <TableHead key={c.key}>{c.label}</TableHead>
                    ))}
                    <TableHead>Status</TableHead>
                    <TableHead>Reason</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.rows.map((row, i) => (
                    <TableRow
                      key={row.rowNumber}
                      className={i % 2 === 1 ? "bg-muted/30" : undefined}
                    >
                      <TableCell className="text-muted-foreground">
                        {row.rowNumber}
                      </TableCell>
                      {columns.map((c) => (
                        <TableCell key={c.key}>
                          {row.display[c.key] ?? ""}
                        </TableCell>
                      ))}
                      <TableCell>
                        <Badge variant={STATUS_VARIANT[row.status]}>
                          {STATUS_LABEL[row.status]}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {row.reason ?? "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                  {preview.rows.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={columns.length + 3}
                        className="text-center text-muted-foreground"
                      >
                        No rows found in that file.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setStep("upload");
                  setPreview(null);
                  setFileName(null);
                }}
              >
                Choose a different file
              </Button>
              <Button
                type="button"
                onClick={handleConfirm}
                disabled={confirming || preview.counts.ok === 0}
              >
                {confirming && <Loader2 className="size-4 animate-spin" />}
                Import {preview.counts.ok} row
                {preview.counts.ok === 1 ? "" : "s"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
