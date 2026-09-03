import { ROOM_CONFLICT_PREFIX } from "@/lib/timetable-conflicts";

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

// Like getActionErrorMessage, but for the drag-and-drop Timetable Builder's
// schedule/move/update failures: the timetable actions throw genuine,
// user-facing SENTENCES for a room/lecturer/class conflict
// (findTimetableConflicts) or an invalid teaching day (assertValidDay).
// The plain fallback ("Could not schedule this session.") hides those, so
// a real conflict — very common when placing a session cross-period, since
// a class's default room is usually already booked by another class at
// that time — looks like a mysterious rejection of the cross-period
// override itself. Show the actual sentence; keep the generic fallback
// only for opaque internal CODES (e.g. ASSIGNMENT_NOT_FOUND).
export function getSchedulingErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const SENTINEL = "__UNRECOGNIZED_e7c1__";
  const known = getActionErrorMessage(error, SENTINEL);
  if (known !== SENTINEL) return known; // a recognized code -> its friendly text
  const message = error.message.startsWith(ROOM_CONFLICT_PREFIX)
    ? error.message.slice(ROOM_CONFLICT_PREFIX.length)
    : error.message;
  // Prose (has whitespace, isn't a bare SCREAMING_SNAKE_CASE token) is
  // safe and useful to show verbatim; anything else stays generic.
  const looksLikeCode = /^[A-Z0-9_]+$/.test(message.trim());
  return message.trim().length > 0 && /\s/.test(message) && !looksLikeCode ? message : fallback;
}
