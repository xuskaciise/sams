// Display-only formatting for the app's stored 24-hour "HH:MM" time
// strings. Stored values (Shift.startTime/endTime, TimetableSlot times,
// etc.) stay 24-hour everywhere — this is the ONE place a clock time is
// turned into 12-hour text for the UI, so every grid / export / label
// reads the same. Native <input type="time"> editors keep their own
// 24-hour value; only rendered labels go through here.
//
// Pure, no imports — safe on the server and in client components.

// "13:00" -> "1:00 PM", "09:05" -> "9:05 AM", "00:00" -> "12:00 AM",
// "12:00" -> "12:00 PM". Anything that isn't a valid HH:MM is returned
// unchanged (a half-typed value in a form never renders as "NaN").
export function formatTime12h(value: string | null | undefined): string {
  const raw = (value ?? "").trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (!m) return raw;
  const h = Number(m[1]);
  const minutes = m[2];
  if (h < 0 || h > 23 || Number(minutes) > 59) return raw;
  const suffix = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${minutes} ${suffix}`;
}

// "13:00"–"14:30" -> "1:00 PM – 2:30 PM". Uses an en dash with spaces,
// matching the on-screen grid style.
export function formatTimeRange12h(
  start: string | null | undefined,
  end: string | null | undefined
): string {
  return `${formatTime12h(start)} – ${formatTime12h(end)}`;
}
