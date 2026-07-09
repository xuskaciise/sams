"use client";

import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// Debounced so a server-paginated table (URL change -> Server Component
// re-fetch) doesn't re-fetch on every keystroke. Keeps its own local
// value so typing feels instant; only calls onChange once typing pauses.
export function TableSearchInput({
  value,
  onChange,
  placeholder = "Search…",
  className,
  delay = 350,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  delay?: number;
}) {
  const [local, setLocal] = useState(value);

  // Keep in sync if the URL/value changes from outside this input (e.g. a
  // filter reset or browser back/forward). Adjusted during render rather
  // than in an effect, per React's "adjusting state when a prop changes"
  // pattern — avoids an extra render pass from setState-in-effect.
  const [prevValue, setPrevValue] = useState(value);
  if (value !== prevValue) {
    setPrevValue(value);
    setLocal(value);
  }

  useEffect(() => {
    const timer = setTimeout(() => {
      if (local !== value) onChange(local);
    }, delay);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local]);

  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        placeholder={placeholder}
        className="pl-8"
      />
    </div>
  );
}
