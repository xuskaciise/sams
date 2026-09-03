export function getActionErrorMessage(
  error: unknown,
  fallback: string
): string {
  if (error instanceof Error) {
    if (error.message === "UNAUTHENTICATED") {
      return "Your session has expired. Please log in again.";
    }
    if (error.message === "FORBIDDEN") {
      return "You don't have permission to do this.";
    }
    if (error.message === "FILE_TOO_LARGE") {
      return "That file is too large (max 5MB).";
    }
    if (error.message === "TOO_MANY_ROWS") {
      return "That file has too many rows (max 2000).";
    }
    if (error.message === "UNREADABLE_FILE") {
      return "Could not read that file. Please upload a valid .xlsx or .csv file.";
    }
    if (error.message === "NO_FILE") {
      return "Please choose a file to upload.";
    }
    if (error.message === "CLOSED_SEMESTER") {
      return "This semester is closed. No further changes are allowed.";
    }
    if (error.message === "SAME_LECTURER") {
      return "That lecturer already teaches this assignment.";
    }
    if (error.message.startsWith("ROOM_CONFLICT::")) {
      // The manual timetable clients strip this prefix themselves to open
      // the open-rooms picker; this is the plain-text fallback for anyone
      // who just surfaces the message.
      return error.message.slice("ROOM_CONFLICT::".length);
    }
    if (error.message === "RECENTLY_SENT") {
      return "Timetable notifications for this were already queued moments ago. Review the warning and click “Resend anyway” if you really want to send again.";
    }
  }
  return fallback;
}
