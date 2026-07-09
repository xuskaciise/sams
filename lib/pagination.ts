export const PAGE_SIZE_OPTIONS = [10, 25, 50] as const;
export const DEFAULT_PAGE_SIZE = 10;

export interface PageParams {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}

// Server-side counterpart to hooks/use-url-table-state.ts — parses the
// same `page`/`pageSize` query params it writes. Invalid/out-of-range
// values fall back to sane defaults rather than erroring, since these
// come straight off the URL and a stale/hand-edited link should degrade
// gracefully, not 500.
export function resolvePageParams(
  searchParams: { page?: string; pageSize?: string },
  defaultPageSize: number = DEFAULT_PAGE_SIZE
): PageParams {
  const page = Math.max(1, Math.floor(Number(searchParams.page)) || 1);
  const requestedSize = Math.floor(Number(searchParams.pageSize));
  const pageSize = (PAGE_SIZE_OPTIONS as readonly number[]).includes(requestedSize)
    ? requestedSize
    : defaultPageSize;
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  from: number;
  to: number;
}

export function buildPageMeta(
  total: number,
  page: number,
  pageSize: number
): PageMeta {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return { page, pageSize, total, totalPages, from, to };
}
