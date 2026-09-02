"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  KeyRound,
  Loader2,
  Printer,
  Download,
  MessageCircle,
  Check,
} from "lucide-react";
import type { Department } from "@prisma/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import { getActionErrorMessage } from "@/lib/action-error";
import {
  generateAccountsForDepartment,
  generateAccountForLecturer,
  resetLecturerPassword,
  shareLecturerCredentials,
  type GeneratedLecturerAccount,
} from "./actions";

// Sentinel for "lecturers with no department set" — mirrors the "all"/
// non-empty-sentinel convention used elsewhere in this app for a Select
// value that isn't a real id (see e.g. Assignments' ALL_SEMESTERS_VALUE).
export const UNASSIGNED_VALUE = "unassigned";

// Ciphertext-free shape from panel.tsx — pendingCredential never crosses
// to the client, only `hasStoredCredential`.
type LecturerRow = {
  id: string;
  staffNo: string;
  fullName: string;
  phoneNumber: string | null;
  departmentId: string | null;
  user: {
    id: string;
    lockedUntil: Date | string | null;
    mustChangePw: boolean;
    credentialsLinkOpenedAt: Date | string | null;
  } | null;
  hasStoredCredential: boolean;
};

type AccountStatus = "No phone" | "No account" | "Active" | "Locked";

// Per-lecturer "Share via WhatsApp" state. The popup tracks it purely
// client-side (the temp password lives only in memory there); the main
// table derives a base state from the row's mustChangePw /
// credentialsLinkOpenedAt and a local override takes over once the admin
// acts on that row.
type ShareState = "idle" | "opening" | "opened" | "already_opened" | "password_changed";

function getStatus(lecturer: LecturerRow): AccountStatus {
  if (!lecturer.user) {
    return lecturer.phoneNumber ? "No account" : "No phone";
  }
  if (
    lecturer.user.lockedUntil &&
    new Date(lecturer.user.lockedUntil) > new Date()
  ) {
    return "Locked";
  }
  return "Active";
}

const STATUS_VARIANT: Record<
  AccountStatus,
  "outline" | "published" | "destructive"
> = {
  "No phone": "outline",
  "No account": "outline",
  Active: "published",
  Locked: "destructive",
};

function downloadCsv(accounts: GeneratedLecturerAccount[]) {
  const header = "Staff No,Full Name,Phone Number,Temporary Password";
  const rows = accounts.map(
    (a) => `${a.staffNo},"${a.fullName}",${a.phoneNumber},${a.tempPassword}`
  );
  const csv = [header, ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "lecturer-accounts.csv";
  link.click();
  URL.revokeObjectURL(url);
}

function printAccounts(accounts: GeneratedLecturerAccount[]) {
  const win = window.open("", "_blank");
  if (!win) return;
  const rows = accounts
    .map(
      (a) =>
        `<tr><td>${a.staffNo}</td><td>${a.fullName}</td><td>${a.phoneNumber}</td><td>${a.tempPassword}</td></tr>`
    )
    .join("");
  win.document.write(`
    <html>
      <head>
        <title>Lecturer temporary passwords</title>
        <style>
          body { font-family: sans-serif; padding: 24px; }
          table { border-collapse: collapse; width: 100%; }
          th, td { border: 1px solid #ccc; padding: 8px 12px; text-align: left; }
          th { background: #f3f4f6; }
        </style>
      </head>
      <body>
        <h2>Lecturer temporary passwords</h2>
        <p>These passwords are shown only once. Distribute securely. Each lecturer logs in with their PHONE NUMBER, not email.</p>
        <table>
          <thead><tr><th>Staff No</th><th>Full Name</th><th>Phone (login)</th><th>Temporary Password</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </body>
    </html>
  `);
  win.document.close();
  win.focus();
  win.print();
}

const SHARE_AGAIN_CONFIRM =
  "You've already opened the WhatsApp share link for this temp password once. It's still valid (the lecturer hasn't changed it), so opening it again is fine if the first message didn't go through — but if in doubt, use Reset Password to issue a fresh one. Open the link again?";

export function LecturerAccountsClient({
  departments,
  selectedDepartmentId,
  lecturers,
  domainConfigured,
  credentialStoreReady,
}: {
  departments: Department[];
  selectedDepartmentId: string;
  lecturers: LecturerRow[];
  domainConfigured: boolean;
  credentialStoreReady: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [generatingDept, setGeneratingDept] = useState(false);
  const [busyLecturerId, setBusyLecturerId] = useState<string | null>(null);
  const [result, setResult] = useState<GeneratedLecturerAccount[] | null>(null);
  const [singleResult, setSingleResult] = useState<{
    lecturerId: string;
    staffNo: string;
    fullName: string;
    tempPassword: string;
  } | null>(null);
  const [shareState, setShareState] = useState<Record<string, ShareState>>({});

  const eligibleForBulk = lecturers.filter((l) => !l.user && l.phoneNumber).length;
  // wa.me sharing doesn't depend on the Baileys worker at all, so it's
  // NOT gated by the WhatsApp on/off toggle — only the login domain
  // (needed for the {domainName} in the message) has to be set.
  const canShare = domainConfigured;
  const shareBlockedReason = !domainConfigured
    ? "Set a login domain on the WhatsApp page before sharing credentials."
    : null;

  // How many of the just-generated accounts have had their share link
  // opened — a small "work through the list" progress hint in the dialog.
  const openedInResult = result
    ? result.filter((a) => shareState[a.lecturerId] === "opened").length
    : 0;

  function onDeptChange(value: string) {
    if (!value) return;
    router.push(`/admin/lecturers?tab=lecturer-accounts&departmentId=${value}`);
  }

  async function onGenerateForDept() {
    setGeneratingDept(true);
    try {
      const { created, skippedNoPhone } = await generateAccountsForDepartment(
        selectedDepartmentId === UNASSIGNED_VALUE ? null : selectedDepartmentId
      );
      if (created.length === 0) {
        toast.info("Every lecturer with a phone number here already has an account.");
      } else {
        setShareState({});
        setResult(created);
        if (skippedNoPhone > 0) {
          toast.warning(
            `${skippedNoPhone} lecturer(s) skipped — no phone number on file.`
          );
        }
      }
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(
        getActionErrorMessage(error, "Something went wrong. Please try again.")
      );
    } finally {
      setGeneratingDept(false);
    }
  }

  async function onGenerateForLecturer(lecturer: LecturerRow) {
    setBusyLecturerId(lecturer.id);
    try {
      const { tempPassword } = await generateAccountForLecturer(lecturer.id);
      setShareState({});
      setSingleResult({
        lecturerId: lecturer.id,
        staffNo: lecturer.staffNo,
        fullName: lecturer.fullName,
        tempPassword,
      });
      startTransition(() => router.refresh());
    } catch (error) {
      if (error instanceof Error && error.message === "NO_PHONE_NUMBER") {
        toast.error("This lecturer has no phone number — set one in Lecturer Registration first.");
      } else {
        toast.error(
          getActionErrorMessage(error, "Something went wrong. Please try again.")
        );
      }
    } finally {
      setBusyLecturerId(null);
    }
  }

  async function onResetPassword(lecturer: LecturerRow) {
    setBusyLecturerId(lecturer.id);
    try {
      const { tempPassword } = await resetLecturerPassword(lecturer.id);
      setShareState({});
      setSingleResult({
        lecturerId: lecturer.id,
        staffNo: lecturer.staffNo,
        fullName: lecturer.fullName,
        tempPassword,
      });
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(
        getActionErrorMessage(error, "Something went wrong. Please try again.")
      );
    } finally {
      setBusyLecturerId(null);
    }
  }

  // Opens WhatsApp for ONE lecturer via a wa.me deep link. The blank tab
  // is opened SYNCHRONOUSLY in the click handler (a window.open after an
  // awaited server call is blocked by popup blockers) and pointed at the
  // real URL once the action resolves, or closed on failure.
  async function shareOne(
    lecturerId: string,
    tempPassword?: string,
    opts?: { force?: boolean }
  ) {
    const win = window.open("", "_blank");
    setShareState((s) => ({ ...s, [lecturerId]: "opening" }));
    try {
      const { status, url } = await shareLecturerCredentials({
        lecturerId,
        tempPassword,
        force: opts?.force,
      });
      if (status === "opened" && url) {
        if (win) win.location.href = url;
        else window.open(url, "_blank");
        setShareState((s) => ({ ...s, [lecturerId]: "opened" }));
        toast.success("WhatsApp opened — review the message and hit Send there.");
        // Reflect the new credentialsLinkOpenedAt on the table row.
        startTransition(() => router.refresh());
      } else {
        win?.close();
        setShareState((s) => ({ ...s, [lecturerId]: "idle" }));
        toast.warning("This lecturer has no phone number on file — nothing to share.");
      }
    } catch (error) {
      win?.close();
      const message = error instanceof Error ? error.message : "";
      if (message === "ALREADY_OPENED") {
        setShareState((s) => ({ ...s, [lecturerId]: "already_opened" }));
      } else if (message === "PASSWORD_CHANGED") {
        setShareState((s) => ({ ...s, [lecturerId]: "password_changed" }));
      } else {
        setShareState((s) => ({ ...s, [lecturerId]: "idle" }));
        toast.error(
          message === "DOMAIN_NOT_CONFIGURED"
            ? "Set a login domain on the WhatsApp page first."
            : message === "NO_STORED_CREDENTIAL"
              ? "No stored credential for this account — use Reset Password to issue a fresh one."
              : getActionErrorMessage(error, "Could not build the share link.")
        );
      }
    }
  }

  function shareAgainConfirm(lecturerId: string, tempPassword?: string) {
    if (window.confirm(SHARE_AGAIN_CONFIRM)) {
      void shareOne(lecturerId, tempPassword, { force: true });
    }
  }

  // A plain render helper (not a nested component) — it closes over
  // shareState/canShare and is invoked inline, so it never remounts and
  // doesn't trip the "component created during render" rule.
  //
  // `tempPassword` is set only from the post-generation popup (in-memory);
  // omitted from the persistent table, where the server falls back to the
  // stored encrypted credential. `mustChangePw`/`credentialsLinkOpenedAt`
  // give the table cell its base state before any local action;
  // `storedAvailable` is the row's hasStoredCredential.
  function shareCredentialsCell(o: {
    lecturerId: string;
    tempPassword?: string;
    mustChangePw?: boolean;
    linkOpenedAt?: Date | string | null;
    storedAvailable?: boolean;
  }) {
    const { lecturerId, tempPassword } = o;
    const mustChangePw = o.mustChangePw ?? true;
    const linkOpenedAt = o.linkOpenedAt ?? null;
    const storedAvailable = o.storedAvailable ?? true;
    const st: ShareState =
      shareState[lecturerId] ??
      (!mustChangePw ? "password_changed" : linkOpenedAt ? "already_opened" : "idle");

    if (!canShare) {
      return (
        <span className="text-xs text-muted-foreground" title={shareBlockedReason ?? undefined}>
          Set login domain first
        </span>
      );
    }
    // Hard block wins over any "how would we even build a link" hint below.
    if (st === "password_changed") {
      return (
        <span className="text-xs text-amber-600">
          Password already changed — use Reset Password
        </span>
      );
    }
    // Persistent table paths need a decryptable stored credential.
    if (tempPassword === undefined && st !== "opened") {
      if (!credentialStoreReady) {
        return (
          <span
            className="text-xs text-muted-foreground"
            title="Set CREDENTIAL_ENCRYPTION_KEY on the server to enable this."
          >
            Share unavailable
          </span>
        );
      }
      if (!storedAvailable) {
        return (
          <span className="text-xs text-muted-foreground">
            Reset password to share
          </span>
        );
      }
    }
    if (st === "opened") {
      return (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Check className="size-3.5 text-green-600" />
          Link opened
          <button
            type="button"
            className="underline hover:text-foreground"
            onClick={() => shareAgainConfirm(lecturerId, tempPassword)}
          >
            Share again
          </button>
        </span>
      );
    }
    if (st === "already_opened") {
      return (
        <span className="text-xs text-amber-600">
          Link already opened —{" "}
          <button
            type="button"
            className="underline hover:text-amber-700"
            onClick={() => shareAgainConfirm(lecturerId, tempPassword)}
          >
            Share again
          </button>
        </span>
      );
    }
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={st === "opening"}
        onClick={() => shareOne(lecturerId, tempPassword)}
      >
        {st === "opening" ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <MessageCircle className="size-3.5" />
        )}
        Share via WhatsApp
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Lecturer Accounts"
        description="Generate and reset lecturer logins, per department. Lecturers log in with their phone number, not email."
        action={
          selectedDepartmentId && (
            <Button
              onClick={onGenerateForDept}
              disabled={generatingDept || eligibleForBulk === 0}
            >
              {generatingDept ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <KeyRound className="size-4" />
              )}
              Generate accounts for this department
            </Button>
          )
        }
      />

      <div className="max-w-xs">
        <SearchableSelect
          value={selectedDepartmentId}
          onValueChange={onDeptChange}
          items={[
            { value: UNASSIGNED_VALUE, label: "Unassigned" },
            ...departments.map((d) => ({ value: d.id, label: `${d.name} (${d.code})` })),
          ]}
          placeholder="Select a department"
          searchPlaceholder="Search departments…"
          className="w-full"
        />
      </div>

      {selectedDepartmentId && (
        <>
          <p className="text-xs text-muted-foreground">
            {!canShare ? (
              <span className="text-amber-600">{shareBlockedReason}</span>
            ) : !credentialStoreReady ? (
              <span className="text-amber-600">
                Credential storage isn&apos;t configured on the server — set
                CREDENTIAL_ENCRYPTION_KEY to share from the table.
              </span>
            ) : (
              "Open WhatsApp for each lecturer below to share their login — you hit Send inside WhatsApp yourself."
            )}
          </p>
          <div className="rounded-lg border border-border">
          <Table>
            <TableHeader className="sticky top-0 bg-card">
              <TableRow>
                <TableHead>Staff no.</TableHead>
                <TableHead>Full name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-60" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {lecturers.map((lecturer, i) => {
                const status = getStatus(lecturer);
                return (
                  <TableRow
                    key={lecturer.id}
                    className={i % 2 === 1 ? "bg-muted/30" : undefined}
                  >
                    <TableCell className="font-medium">
                      {lecturer.staffNo}
                    </TableCell>
                    <TableCell>{lecturer.fullName}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[status]}>{status}</Badge>
                      {lecturer.user?.credentialsLinkOpenedAt && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          · credentials link opened
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {status === "No phone" ? (
                        <span className="text-xs text-muted-foreground">
                          Set a phone number first
                        </span>
                      ) : status === "No account" ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busyLecturerId === lecturer.id}
                          onClick={() => onGenerateForLecturer(lecturer)}
                        >
                          Generate account
                        </Button>
                      ) : (
                        <div className="flex flex-col items-start gap-1.5">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busyLecturerId === lecturer.id}
                            onClick={() => onResetPassword(lecturer)}
                          >
                            Reset password
                          </Button>
                          {shareCredentialsCell({
                            lecturerId: lecturer.id,
                            mustChangePw: lecturer.user?.mustChangePw ?? true,
                            linkOpenedAt: lecturer.user?.credentialsLinkOpenedAt ?? null,
                            storedAvailable: lecturer.hasStoredCredential,
                          })}
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {lecturers.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={4}
                    className="text-center text-muted-foreground"
                  >
                    No lecturers in this department.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          </div>
        </>
      )}

      <Dialog
        open={!!result}
        onOpenChange={(open) => !open && setResult(null)}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Accounts generated</DialogTitle>
            <DialogDescription>
              These temporary passwords are shown only this once — they
              can&apos;t be viewed again after you close this dialog. Each
              lecturer logs in with their PHONE NUMBER, not email. Download,
              print, or open WhatsApp per lecturer to share them now.
            </DialogDescription>
          </DialogHeader>
          {!canShare ? (
            <p className="text-xs text-amber-600">{shareBlockedReason}</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {openedInResult} of {result?.length ?? 0} share link
              {(result?.length ?? 0) === 1 ? "" : "s"} opened — go through each row.
            </p>
          )}
          <div className="max-h-80 overflow-y-auto rounded-lg border border-border">
            <Table>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow>
                  <TableHead>Staff no.</TableHead>
                  <TableHead>Full name</TableHead>
                  <TableHead>Phone (login)</TableHead>
                  <TableHead>Temp password</TableHead>
                  <TableHead>Share</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result?.map((a) => (
                  <TableRow key={a.staffNo}>
                    <TableCell>{a.staffNo}</TableCell>
                    <TableCell>{a.fullName}</TableCell>
                    <TableCell>{a.phoneNumber}</TableCell>
                    <TableCell className="font-mono">
                      {a.tempPassword}
                    </TableCell>
                    <TableCell>
                      {shareCredentialsCell({
                        lecturerId: a.lecturerId,
                        tempPassword: a.tempPassword,
                      })}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => result && downloadCsv(result)}
            >
              <Download className="size-4" />
              Download CSV
            </Button>
            <Button
              variant="outline"
              onClick={() => result && printAccounts(result)}
            >
              <Printer className="size-4" />
              Print
            </Button>
            <Button onClick={() => setResult(null)} className="ml-auto">
              Done
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!singleResult}
        onOpenChange={(open) => !open && setSingleResult(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Temporary password</DialogTitle>
            <DialogDescription>
              Share this with {singleResult?.fullName} ({singleResult?.staffNo}
              ). They log in with their phone number. It won&apos;t be shown
              again.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-border bg-muted p-3 font-mono text-sm">
            {singleResult?.tempPassword}
          </div>
          <div className="flex items-center justify-between gap-3">
            {singleResult
              ? shareCredentialsCell({
                  lecturerId: singleResult.lecturerId,
                  tempPassword: singleResult.tempPassword,
                })
              : null}
            <Button onClick={() => setSingleResult(null)}>Done</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
