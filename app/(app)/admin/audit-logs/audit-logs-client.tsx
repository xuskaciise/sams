"use client";

import type { AuditLog } from "@prisma/client";
import { PageHeader } from "@/components/layout/page-header";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TableSearchInput } from "@/components/ui/table-search-input";
import { TablePagination } from "@/components/ui/table-pagination";
import { useUrlTableState } from "@/lib/use-url-table-state";

type AuditLogRow = AuditLog & { user: { fullName: string } | null };

export function AuditLogsClient({
  logs,
  entities,
  total,
  page,
  pageSize,
}: {
  logs: AuditLogRow[];
  entities: string[];
  total: number;
  page: number;
  pageSize: number;
}) {
  const table = useUrlTableState(25);
  const entityItems = [
    { value: "all", label: "All entities" },
    ...entities.map((entity) => ({ value: entity, label: entity })),
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Audit Logs"
        description="Every critical action across the system — logins, marks entry, publish, corrections, ownership transfers, and more."
      />

      <div className="flex flex-wrap gap-3">
        <TableSearchInput
          value={table.search}
          onChange={table.setSearch}
          placeholder="Search by action, entity, or user…"
          className="w-full sm:w-80"
        />
        <div className="w-48">
          <Select
            value={table.getFilter("entity") || "all"}
            onValueChange={(value) =>
              table.setFilter("entity", value === "all" ? "" : (value ?? ""))
            }
            items={entityItems}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="All entities" />
            </SelectTrigger>
            <SelectContent>
              {entityItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead>Action</TableHead>
              <TableHead>Entity</TableHead>
              <TableHead>By</TableHead>
              <TableHead className="text-right">When</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {logs.map((entry, i) => (
              <TableRow
                key={entry.id}
                className={i % 2 === 1 ? "bg-muted/30" : undefined}
              >
                <TableCell className="font-medium">{entry.action}</TableCell>
                <TableCell className="text-muted-foreground">{entry.entity}</TableCell>
                <TableCell className="text-muted-foreground">
                  {entry.user?.fullName ?? "System"}
                </TableCell>
                <TableCell className="text-right text-muted-foreground">
                  {entry.createdAt.toLocaleString()}
                </TableCell>
              </TableRow>
            ))}
            {logs.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-muted-foreground">
                  No activity matches these filters.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        <TablePagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={table.setPage}
          onPageSizeChange={table.setPageSize}
          pageSizeOptions={[25, 50, 100]}
        />
      </div>
    </div>
  );
}
