"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getActionErrorMessage } from "@/lib/action-error";
import { downloadBase64 } from "@/lib/download";
import { exportMyResults } from "../actions";

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function TranscriptDownloadButton() {
  const [exporting, setExporting] = useState(false);

  async function onExport() {
    setExporting(true);
    try {
      const { base64, fileName } = await exportMyResults();
      downloadBase64(base64, fileName, XLSX_MIME);
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not export your results."));
    } finally {
      setExporting(false);
    }
  }

  return (
    <Button variant="outline" onClick={onExport} disabled={exporting}>
      {exporting ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <Download className="size-4" />
      )}
      Download report
    </Button>
  );
}
