"use client";

import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CloudUpload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getActionErrorMessage } from "@/lib/action-error";
import {
  disconnectGoogleDrive,
  requestDriveBackupNow,
} from "./drive-backup-actions";

export interface DriveBackupCardData {
  available: boolean;
  connection: {
    needsReconnect: boolean;
    lastBackupAt: string | null;
    lastBackupStatus: "SUCCESS" | "FAILED" | "PENDING" | null;
    lastErrorMessage: string | null;
  } | null;
  // ?drive=… outcome from the OAuth callback redirect, shown once.
  outcome: string | null;
}

const OUTCOME_MESSAGES: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "Google Drive connected — your first backup runs within a minute." },
  denied: { ok: false, text: "Google Drive connection was cancelled." },
  error: { ok: false, text: "Could not connect Google Drive. Please try again." },
  unavailable: { ok: false, text: "Google Drive backup isn't configured on this server." },
  forbidden: { ok: false, text: "You don't have permission to connect Google Drive." },
};

function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function DriveBackupCard({ data }: { data: DriveBackupCardData }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const { connection } = data;

  useEffect(() => {
    const msg = data.outcome ? OUTCOME_MESSAGES[data.outcome] : undefined;
    if (!msg) return;
    if (msg.ok) toast.success(msg.text);
    else toast.error(msg.text);
    // Drop ?drive= so a refresh doesn't re-toast.
    router.replace("/");
  }, [data.outcome, router]);

  const status = !connection
    ? { label: "Not connected", variant: "outline" as const }
    : connection.needsReconnect
      ? { label: "Needs reconnect", variant: "destructive" as const }
      : { label: "Connected", variant: "published" as const };

  function onDisconnect() {
    if (!window.confirm("Disconnect Google Drive? Your existing backup file stays in your Drive, but SAMS will stop updating it.")) {
      return;
    }
    startTransition(async () => {
      try {
        await disconnectGoogleDrive();
        toast.success("Google Drive disconnected.");
        router.refresh();
      } catch (error) {
        toast.error(getActionErrorMessage(error, "Could not disconnect Google Drive."));
      }
    });
  }

  function onBackupNow() {
    startTransition(async () => {
      try {
        await requestDriveBackupNow();
        toast.success("Backup queued — it will run within a minute.");
        router.refresh();
      } catch (error) {
        toast.error(getActionErrorMessage(error, "Could not queue a backup."));
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CloudUpload className="size-4" />
          Google Drive backup
          <Badge variant={status.variant}>{status.label}</Badge>
        </CardTitle>
        <CardDescription>
          Keeps one Excel copy of your own marks (drafts included) in your
          Google Drive, updated a few minutes after you change marks and at
          least once a day.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!data.available && !connection ? (
          <p className="text-muted-foreground">
            Google Drive backup isn&apos;t configured on this server.
          </p>
        ) : (
          <>
            {connection && (
              <p>
                Last backup:{" "}
                <span className="font-medium">
                  {connection.lastBackupAt ? relativeTime(connection.lastBackupAt) : "Never"}
                </span>
                {connection.lastBackupStatus === "PENDING" && !connection.needsReconnect && (
                  <span className="text-muted-foreground"> · backup pending</span>
                )}
              </p>
            )}
            {connection?.needsReconnect && (
              <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-amber-900">
                SAMS can no longer reach your Google Drive (access was revoked
                or expired). Reconnect to resume backups.
              </p>
            )}
            {connection &&
              !connection.needsReconnect &&
              connection.lastBackupStatus === "FAILED" &&
              connection.lastErrorMessage && (
                <p className="text-destructive">
                  Last attempt failed — it will be retried automatically.
                </p>
              )}
            <div className="flex flex-wrap gap-2">
              {(!connection || connection.needsReconnect) && data.available && (
                <a
                  href="/api/google-drive/connect"
                  className={buttonVariants({ size: "sm" })}
                >
                  {connection ? "Reconnect Google Drive" : "Connect Google Drive"}
                </a>
              )}
              {connection && !connection.needsReconnect && (
                <Button size="sm" variant="outline" disabled={pending} onClick={onBackupNow}>
                  Back up now
                </Button>
              )}
              {connection && (
                <Button size="sm" variant="ghost" disabled={pending} onClick={onDisconnect}>
                  Disconnect
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
