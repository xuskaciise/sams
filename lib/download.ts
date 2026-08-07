// Base64 crosses the Server Action boundary as plain JSON; this turns it
// back into a real file download client-side. Shared by bulk-import
// templates and Dean report exports.
export function downloadBase64(base64: string, fileName: string, mime: string) {
  const byteChars = atob(base64);
  const byteNumbers = new Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) {
    byteNumbers[i] = byteChars.charCodeAt(i);
  }
  downloadBlob(new Blob([new Uint8Array(byteNumbers)], { type: mime }), fileName);
}

// For exports built ENTIRELY client-side (no Server Action round trip) —
// e.g. the workload-import multi-class preview's PDF/Excel export, which
// exports in-memory preview edits that don't exist server-side at all yet
// (see admin/auto-timetable/preview-export.ts). Same download mechanics as
// downloadBase64, just starting from a Blob the caller already has instead
// of a base64 string that needs decoding first.
export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}
