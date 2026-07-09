"use client";

import { useCallback } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { DEFAULT_PAGE_SIZE } from "./pagination";

// URL-synced page/pageSize/search/filter state for server-paginated
// tables — pairs with lib/pagination.ts's resolvePageParams on the
// server side (same `page`/`pageSize` param names). Any filter or
// search change resets `page` back to 1 (a stale page number past the
// end of a newly-filtered result set is confusing, not helpful); a page
// or pageSize change on its own does not touch anything else. Works
// inside hub-tabbed pages for free — it only ever edits the specific
// keys it's told to, so `tab` and any other page's params pass through
// untouched.
export function useUrlTableState(defaultPageSize: number = DEFAULT_PAGE_SIZE) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const page = Math.max(1, Math.floor(Number(searchParams.get("page"))) || 1);
  const pageSizeParam = Math.floor(Number(searchParams.get("pageSize")));
  const pageSize = [10, 25, 50].includes(pageSizeParam) ? pageSizeParam : defaultPageSize;
  const search = searchParams.get("q") ?? "";

  const applyParams = useCallback(
    (updates: Record<string, string | null>, resetPage: boolean) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === "") params.delete(key);
        else params.set(key, value);
      }
      if (resetPage) params.delete("page");
      router.push(`${pathname}?${params.toString()}`);
    },
    [router, pathname, searchParams]
  );

  const getFilter = useCallback(
    (key: string) => searchParams.get(key) ?? "",
    [searchParams]
  );

  return {
    page,
    pageSize,
    search,
    getFilter,
    setPage: (next: number) => applyParams({ page: String(next) }, false),
    setPageSize: (next: number) => applyParams({ pageSize: String(next) }, true),
    setSearch: (next: string) => applyParams({ q: next }, true),
    setFilter: (key: string, next: string) => applyParams({ [key]: next }, true),
  };
}
