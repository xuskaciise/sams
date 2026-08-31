"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RotateCcw } from "lucide-react";
import type { WhatsAppNotificationLog, WhatsAppSettings, WhatsAppMessageTemplate } from "@prisma/client";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { TableSearchInput } from "@/components/ui/table-search-input";
import { TablePagination } from "@/components/ui/table-pagination";
import { useUrlTableState } from "@/lib/use-url-table-state";
import { getActionErrorMessage } from "@/lib/action-error";
import { Input } from "@/components/ui/input";
import { setWhatsAppEnabled, setWhatsAppDomain, retryWhatsAppNotification } from "./actions";
import { TemplatesClient } from "./templates-client";

// A worker heartbeat older than this reads as stale — the stored
// connectionStatus might say CONNECTED, but if the worker process itself
// has gone quiet (crashed, VPS rebooted, etc.) that value is no longer
// trustworthy. This is a purely presentational judgment call in the
// admin UI; it never affects whether notifications get enqueued (see
// lib/whatsapp-notify.ts, which only checks `enabled`).
const STALE_HEARTBEAT_MS = 2 * 60 * 1000;

const STATUS_ITEMS = [
  { value: "all", label: "All statuses" },
  { value: "PENDING", label: "Pending" },
  { value: "SENT", label: "Sent" },
  { value: "FAILED", label: "Failed" },
];

const STATUS_BADGE: Record<
  WhatsAppNotificationLog["status"],
  "published" | "draft" | "destructive"
> = {
  SENT: "published",
  PENDING: "draft",
  FAILED: "destructive",
};

function ConnectionBadge({ settings }: { settings: WhatsAppSettings | null }) {
  if (!settings) {
    return <Badge variant="destructive">Not configured</Badge>;
  }

  // Date.now() is impure — the React Compiler flags calling it directly
  // during render (same class of exception as the pre-existing
  // eslint-disable in build-timetable-client.tsx, see CLAUDE.md). Harmless
  // here: this only decides which badge to show, recomputed on whatever
  // render happens to occur (page load, router.refresh() after an
  // action) — there's no ticking-clock requirement to justify a
  // setInterval-driven re-render just for this.
  const heartbeatAge = settings.lastHeartbeatAt
    ? // eslint-disable-next-line react-hooks/purity
      Date.now() - new Date(settings.lastHeartbeatAt).getTime()
    : null;
  const isStale = heartbeatAge === null || heartbeatAge > STALE_HEARTBEAT_MS;

  if (settings.connectionStatus === "CONNECTED" && !isStale) {
    return <Badge variant="published">Connected</Badge>;
  }
  if (settings.connectionStatus === "NEEDS_QR_SCAN") {
    return <Badge variant="draft">Needs QR re-scan</Badge>;
  }
  if (settings.connectionStatus === "CONNECTED" && isStale) {
    return <Badge variant="draft">Connected (stale — worker hasn&rsquo;t checked in)</Badge>;
  }
  return <Badge variant="destructive">Disconnected</Badge>;
}

export function WhatsAppClient({
  settings,
  logs,
  total,
  page,
  pageSize,
  pendingCount,
  failedCount,
  templates,
  availableAutomaticKeys,
  canManageTemplates,
}: {
  settings: WhatsAppSettings | null;
  logs: WhatsAppNotificationLog[];
  total: number;
  page: number;
  pageSize: number;
  pendingCount: number;
  failedCount: number;
  templates: (WhatsAppMessageTemplate & { updatedByUser: { fullName: string } | null })[];
  availableAutomaticKeys: string[];
  canManageTemplates: boolean;
}) {
  const router = useRouter();
  const table = useUrlTableState(25);
  const [isPending, startTransition] = useTransition();
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [domainValue, setDomainValue] = useState(settings?.domainName ?? "");
  const [savingDomain, setSavingDomain] = useState(false);

  // The event-type filter (and the log table's own "Event" column) label
  // by whatever the matching template's own `name` currently is — every
  // eventKey a log row can carry has a template row for it at the time it
  // was sent (a deactivated MANUAL template's past deliveries still keep
  // their eventKey; its row is simply not in `templates` if hard-filtered,
  // but this page always fetches every row regardless of deletedAt, so a
  // deactivated template's name still resolves here too).
  const nameByEventKey = new Map(templates.map((t) => [t.eventKey, t.name]));
  const eventTypeItems = [
    { value: "all", label: "All events" },
    ...templates.map((t) => ({ value: t.eventKey, label: t.name })),
  ];

  function handleToggle(next: boolean) {
    startTransition(async () => {
      try {
        await setWhatsAppEnabled(next);
        toast.success(next ? "WhatsApp notifications enabled." : "WhatsApp notifications disabled.");
        router.refresh();
      } catch (error) {
        toast.error(getActionErrorMessage(error, "Could not update the setting."));
      }
    });
  }

  async function handleSaveDomain() {
    setSavingDomain(true);
    try {
      await setWhatsAppDomain(domainValue);
      toast.success("Login domain saved.");
      router.refresh();
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not save the domain."));
    } finally {
      setSavingDomain(false);
    }
  }

  async function handleRetry(id: string) {
    setRetryingId(id);
    try {
      await retryWhatsAppNotification(id);
      toast.success("Queued for retry.");
      router.refresh();
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not retry this notification."));
    } finally {
      setRetryingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="WhatsApp Notifications"
        description="Best-effort, unofficial notifications sent over a self-hosted WhatsApp Web session. Optional and isolated from core app functionality — see CLAUDE.md."
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold text-muted-foreground">
              Feature status
            </CardTitle>
          </CardHeader>
          <CardContent className="flex items-center justify-between gap-3">
            <Badge variant={settings?.enabled ? "published" : "outline"}>
              {settings?.enabled ? "Enabled" : "Disabled"}
            </Badge>
            <Button
              type="button"
              variant={settings?.enabled ? "outline" : "default"}
              size="sm"
              disabled={isPending}
              onClick={() => handleToggle(!settings?.enabled)}
            >
              {settings?.enabled ? "Turn off" : "Turn on"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold text-muted-foreground">
              Session status
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1">
            <ConnectionBadge settings={settings} />
            <p className="text-xs text-muted-foreground">
              {settings?.lastHeartbeatAt
                ? `Last check-in: ${new Date(settings.lastHeartbeatAt).toLocaleString()}`
                : "The VPS worker has never checked in."}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold text-muted-foreground">
              Queue
            </CardTitle>
          </CardHeader>
          <CardContent className="flex gap-4 text-sm">
            <span>
              <span className="font-semibold text-foreground">{pendingCount}</span>{" "}
              <span className="text-muted-foreground">pending</span>
            </span>
            <span>
              <span className="font-semibold text-destructive">{failedCount}</span>{" "}
              <span className="text-muted-foreground">failed</span>
            </span>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold text-muted-foreground">
            Login domain (for lecturer credential messages)
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            value={domainValue}
            onChange={(e) => setDomainValue(e.target.value)}
            placeholder="e.g. sams.university.edu"
            className="sm:max-w-sm"
          />
          <Button
            type="button"
            size="sm"
            disabled={savingDomain || domainValue.trim() === (settings?.domainName ?? "")}
            onClick={handleSaveDomain}
          >
            Save
          </Button>
          <p className="text-xs text-muted-foreground sm:ml-2">
            Shown as <code>{"{domainName}"}</code> in the &ldquo;Lecturer Login
            Credentials&rdquo; message. Credentials can&rsquo;t be sent until
            this is set.
          </p>
        </CardContent>
      </Card>

      <Tabs defaultValue="log">
        <TabsList>
          <TabsTrigger value="log">Delivery Log</TabsTrigger>
          <TabsTrigger value="templates">Notification Templates</TabsTrigger>
        </TabsList>

        <TabsContent value="log" className="flex flex-col gap-4 pt-4">
          <div className="flex flex-wrap gap-3">
            <TableSearchInput
              value={table.search}
              onChange={table.setSearch}
              placeholder="Search by recipient name or phone…"
              className="w-full sm:w-72"
            />
            <div className="w-44">
              <Select
                value={table.getFilter("status") || "all"}
                onValueChange={(value) => table.setFilter("status", !value || value === "all" ? "" : value)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_ITEMS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="w-52">
              <Select
                value={table.getFilter("eventType") || "all"}
                onValueChange={(value) => table.setFilter("eventType", !value || value === "all" ? "" : value)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {eventTypeItems.map((item) => (
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
                  <TableHead>Recipient</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Sent / created</TableHead>
                  <TableHead>Error</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((log, i) => (
                  <TableRow key={log.id} className={i % 2 === 1 ? "bg-muted/30" : undefined}>
                    <TableCell className="font-medium">{log.recipientName}</TableCell>
                    <TableCell>{log.phoneNumber}</TableCell>
                    <TableCell>{nameByEventKey.get(log.eventKey) ?? log.eventKey}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_BADGE[log.status]}>{log.status}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {(log.sentAt ?? log.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell className="max-w-64 truncate text-muted-foreground" title={log.lastError ?? undefined}>
                      {log.lastError ?? "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {log.status === "FAILED" && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={retryingId === log.id}
                          onClick={() => handleRetry(log.id)}
                        >
                          <RotateCcw className="size-3.5" />
                          Retry
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {logs.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-muted-foreground">
                      No notifications match these filters.
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
            />
          </div>
        </TabsContent>

        <TabsContent value="templates" className="pt-4">
          <TemplatesClient
            templates={templates}
            availableAutomaticKeys={availableAutomaticKeys}
            canManage={canManageTemplates}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
