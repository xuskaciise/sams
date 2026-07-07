"use client";

import * as React from "react";
import { ChevronDownIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

export interface SearchableSelectItem {
  value: string;
  label: string;
  /** Extra text to match against when searching, beyond the label (e.g. a student's ID alongside their name). */
  keywords?: string[];
}

export interface SearchableSelectProps {
  value?: string;
  onValueChange: (value: string) => void;
  items: SearchableSelectItem[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
}

function filterBySubstring(itemValue: string, search: string) {
  return itemValue.toLowerCase().includes(search.toLowerCase()) ? 1 : 0;
}

// Same props shape everywhere it's used, so it drops in wherever a plain
// Select currently sits — search/filter, arrow-key + Enter navigation,
// a checkmark on the selected item, an empty-state message, and a
// disabled state all come for free.
export function SearchableSelect({
  value,
  onValueChange,
  items,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyMessage = "No results found.",
  disabled,
  className,
  id,
}: SearchableSelectProps) {
  const [open, setOpen] = React.useState(false);
  const selected = items.find((item) => item.value === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        id={id}
        disabled={disabled}
        data-placeholder={selected ? undefined : ""}
        className={cn(
          "flex h-8 w-fit items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-placeholder:text-muted-foreground dark:bg-input/30 dark:hover:bg-input/50",
          className
        )}
      >
        <span className="line-clamp-1 flex-1 text-left">
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDownIcon className="pointer-events-none size-4 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent
        className="w-(--anchor-width) min-w-56 p-0"
        align="start"
      >
        <Command filter={filterBySubstring}>
          <CommandInput placeholder={searchPlaceholder} autoFocus />
          <CommandList>
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            <CommandGroup>
              {items.map((item) => {
                const searchable = [item.label, ...(item.keywords ?? [])].join(
                  " "
                );
                return (
                  <CommandItem
                    key={item.value}
                    value={searchable}
                    data-checked={item.value === value}
                    onSelect={() => {
                      onValueChange(item.value);
                      setOpen(false);
                    }}
                  >
                    {item.label}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
