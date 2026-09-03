"use client";

import { useEffect, useRef } from "react";

// Runs `callback` every `ms` — but ONLY while the tab is visible (Page
// Visibility API). Hidden tab: the interval is cleared so no requests
// fire. On becoming visible again: `callback` runs once immediately (so
// stale "Now"/"Ended" state catches up right away) and the interval
// restarts. Never fires on mount — the caller already has SSR data.
//
// Used by the Timetable "Now" view and the Lecturer/Student "Today's
// Schedule" dashboard widgets to keep live state fresh without a page
// reload.
export function useVisibleInterval(callback: () => void, ms: number): void {
  // "Latest ref" pattern — keep the interval effect from restarting every
  // time the caller passes a fresh closure, while always invoking the
  // newest one. Assigning the ref in an effect (not during render) is what
  // the react-hooks/refs rule requires.
  const cb = useRef(callback);
  useEffect(() => {
    cb.current = callback;
  }, [callback]);

  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (id === null) id = setInterval(() => cb.current(), ms);
    };
    const stop = () => {
      if (id !== null) {
        clearInterval(id);
        id = null;
      }
    };
    const onVisibilityChange = () => {
      if (document.hidden) {
        stop();
      } else {
        cb.current();
        start();
      }
    };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [ms]);
}
