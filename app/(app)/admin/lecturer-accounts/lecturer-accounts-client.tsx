"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  KeyRound,
  Loader2,
  Printer,
  Download,
  Send,
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
  sendLecturerCredentials,
  sendLecturerCredentialsBatch,
  type GeneratedLecturerAccount,
  type SendCredentialsStatus,
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
    passwordSentAt: Date | string | null;
  } | null;
  hasStoredCredential: boolean;
};

type AccountStatus = "No phone" | "No account" | "Active" | "Locked";

// Per-lecturer "Send credentials" state. The popup tracks it purely
// client-side (the temp password lives only in memory there); the main
// table derives a base state from the row's mustChangePw / passwordSentAt
// and a local override takes over once the admin acts on that row.
type SendState = "idle" | "sending" | "sent" | "already_sent" | "password_changed";

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

const RESEND_CONFIRM =
  "This temp password was already sent once. It's still valid (the lecturer hasn't changed it), so resending the SAME credential is fine if they lost the first message — but if in doubt, use Reset Password to issue a fresh one. Resend anyway?";

export function LecturerAccountsClient({
  departments,
  selectedDepartmentId,
  lecturers,
  whatsappEnabled,
  domainConfigured,
  credentialStoreReady,
}: {
  departments: Department[];
  selectedDepartmentId: string;
  lecturers: LecturerRow[];
  whatsappEnabled: boolean;
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
  const [sendState, setSendState] = useState<Record<string, SendState>>({});
  const [sendingAll, setSendingAll] = useState(false);
  const [sendingAllEligible, setSendingAllEligible] = useState(false);

  const eligibleForBulk = lecturers.filter((l) => !l.user && l.phoneNumber).length;
  const canSend = whatsappEnabled && domainConfigured;
  const sendBlockedReason = !domainConfigured
    ? "Set a login domain on the WhatsApp page before sending credentials."
    : !whatsappEnabled
      ? "Turn WhatsApp notifications on to send credentials."
      : null;

  // Rows the persistent "Send credentials to all eligible" button targets:
  // an un-activated account (mustChangePw), not yet sent, with a stored
  // credential to send. Already-sent rows are resent one-by-one via their
  // own amber "Resend anyway".
  const tableEligible = lecturers.filter(
    (l) =>
      l.user &&
      l.user.mustChangePw &&
      !l.user.passwordSentAt &&
      l.hasStoredCredential
  );

  function summariseBatch(results: { status: SendCredentialsStatus }[]) {
    const c: Record<SendCredentialsStatus, number> = {
      sent: 0,
      already_sent: 0,
      password_changed: 0,
      no_phone_or_disabled: 0,
      no_account: 0,
      no_stored_credential: 0,
    };
    for (const r of results) c[r.status] += 1;
    const parts = [`Sent to ${c.sent}`];
    if (c.already_sent) parts.push(`${c.already_sent} already sent`);
    if (c.password_changed) parts.push(`${c.password_changed} already changed password`);
    if (c.no_phone_or_disabled) parts.push(`${c.no_phone_or_disabled} skipped (no phone / off)`);
    if (c.no_stored_credential) parts.push(`${c.no_stored_credential} have no stored credential`);
    return parts.join(" · ");
  }

  function applyBatchToSendState(
    results: { lecturerId: string; status: SendCredentialsStatus }[]
  ) {
    setSendState((prev) => {
      const next = { ...prev };
      for (const r of results) {
        next[r.lecturerId] =
          r.status === "sent"
            ? "sent"
            : r.status === "already_sent"
              ? "already_sent"
              : r.status === "password_changed"
                ? "password_changed"
                : "idle";
      }
      return next;
    });
  }

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
        setSendState({});
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
      setSendState({});
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
      setSendState({});
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

  async function sendOne(
    lecturerId: string,
    tempPassword?: string,
    opts?: { force?: boolean }
  ) {
    setSendState((s) => ({ ...s, [lecturerId]: "sending" }));
    try {
      const { status } = await sendLecturerCredentials({
        lecturerId,
        tempPassword,
        force: opts?.force,
      });
      if (status === "sent") {
        setSendState((s) => ({ ...s, [lecturerId]: "sent" }));
        toast.success("Credentials sent.");
        // Reflect the new passwordSentAt on the table row.
        startTransition(() => router.refresh());
      } else {
        setSendState((s) => ({ ...s, [lecturerId]: "idle" }));
        toast.warning(
          "Nothing sent — WhatsApp is off or the lecturer has no phone number."
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "ALREADY_SENT") {
        setSendState((s) => ({ ...s, [lecturerId]: "already_sent" }));
      } else if (message === "PASSWORD_CHANGED") {
        setSendState((s) => ({ ...s, [lecturerId]: "password_changed" }));
      } else {
        setSendState((s) => ({ ...s, [lecturerId]: "idle" }));
        toast.error(
          message === "DOMAIN_NOT_CONFIGURED"
            ? "Set a login domain on the WhatsApp page first."
            : message === "NO_STORED_CREDENTIAL"
              ? "No stored credential for this account — use Reset Password to issue a fresh one."
              : getActionErrorMessage(error, "Could not send credentials.")
        );
      }
    }
  }

  function resendConfirm(lecturerId: string, tempPassword?: string) {
    if (window.confirm(RESEND_CONFIRM)) {
      void sendOne(lecturerId, tempPassword, { force: true });
    }
  }

  async function sendAll(accounts: GeneratedLecturerAccount[]) {
    setSendingAll(true);
    try {
      const { results } = await sendLecturerCredentialsBatch({
        items: accounts.map((a) => ({
          lecturerId: a.lecturerId,
          tempPassword: a.tempPassword,
        })),
      });
      applyBatchToSendState(results);
      toast.success(summariseBatch(results));
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      toast.error(
        message === "DOMAIN_NOT_CONFIGURED"
          ? "Set a login domain on the WhatsApp page first."
          : getActionErrorMessage(error, "Could not send credentials.")
      );
    } finally {
      setSendingAll(false);
    }
  }

  // Persistent bulk send from the main table — never carries in-memory
  // passwords; the server decrypts each row's stored credential.
  async function sendAllEligible() {
    if (tableEligible.length === 0) return;
    setSendingAllEligible(true);
    try {
      const { results } = await sendLecturerCredentialsBatch({
        items: tableEligible.map((l) => ({ lecturerId: l.id })),
      });
      applyBatchToSendState(results);
      toast.success(summariseBatch(results));
      startTransition(() => router.refresh());
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      toast.error(
        message === "DOMAIN_NOT_CONFIGURED"
          ? "Set a login domain on the WhatsApp page first."
          : getActionErrorMessage(error, "Could not send credentials.")
      );
    } finally {
      setSendingAllEligible(false);
    }
  }

  // A plain render helper (not a nested component) — it closes over
  // sendState/canSend and is invoked inline, so it never remounts and
  // doesn't trip the "component created during render" rule.
  //
  // `tempPassword` is set only from the post-generation popup (in-memory);
  // omitted from the persistent table, where the server falls back to the
  // stored encrypted credential. `mustChangePw`/`passwordSentAt` give the
  // table cell its base state before any local action; `storedAvailable`
  // is the row's hasStoredCredential.
  function sendCredentialsCell(o: {
    lecturerId: string;
    tempPassword?: string;
    mustChangePw?: boolean;
    passwordSentAt?: Date | string | null;
    storedAvailable?: boolean;
  }) {
    const { lecturerId, tempPassword } = o;
    const mustChangePw = o.mustChangePw ?? true;
    const passwordSentAt = o.passwordSentAt ?? null;
    const storedAvailable = o.storedAvailable ?? true;
    const st: SendState =
      sendState[lecturerId] ??
      (!mustChangePw ? "password_changed" : passwordSentAt ? "already_sent" : "idle");

    if (!canSend) {
      return (
        <span className="text-xs text-muted-foreground" title={sendBlockedReason ?? undefined}>
          {!domainConfigured ? "Set login domain first" : "WhatsApp is off"}
        </span>
      );
    }
    // Hard block wins over any "how would we even send" hint below.
    if (st === "password_changed") {
      return (
        <span className="text-xs text-amber-600">
          Password already changed — use Reset Password
        </span>
      );
    }
    // Persistent table paths need a decryptable stored credential.
    if (tempPassword === undefined && st !== "sent") {
      if (!credentialStoreReady) {
        return (
          <span
            className="text-xs text-muted-foreground"
            title="Set CREDENTIAL_ENCRYPTION_KEY on the server to enable this."
          >
            Send unavailable
          </span>
        );
      }
      if (!storedAvailable) {
        return (
          <span className="text-xs text-muted-foreground">
            Reset password to send
          </span>
        );
      }
    }
    if (st === "sent") {
      return (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Check className="size-3.5 text-green-600" />
          Sent
          <button
            type="button"
            className="underline hover:text-foreground"
            onClick={() => resendConfirm(lecturerId, tempPassword)}
          >
            Resend
          </button>
        </span>
      );
    }
    if (st === "already_sent") {
      return (
        <span className="text-xs text-amber-600">
          Already sent —{" "}
          <button
            type="button"
            className="underline hover:text-amber-700"
            onClick={() => resendConfirm(lecturerId, tempPassword)}
          >
            Resend anyway
          </button>
        </span>
      );
    }
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={st === "sending"}
        onClick={() => sendOne(lecturerId, tempPassword)}
      >
        {st === "sending" ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Send className="size-3.5" />
        )}
        Send credentials
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
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="outline"
              disabled={
                !canSend ||
                !credentialStoreReady ||
                sendingAllEligible ||
                tableEligible.length === 0
              }
              onClick={sendAllEligible}
            >
              {sendingAllEligible ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
              Send credentials to all eligible ({tableEligible.length})
            </Button>
            {!canSend ? (
              <span className="text-xs text-amber-600">{sendBlockedReason}</span>
            ) : !credentialStoreReady ? (
              <span className="text-xs text-amber-600">
                Credential storage isn&apos;t configured on the server — set
                CREDENTIAL_ENCRYPTION_KEY to send from the table.
              </span>
            ) : null}
          </div>
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
                      {lecturer.user?.passwordSentAt && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          · credentials sent
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
                          {sendCredentialsCell({
                            lecturerId: lecturer.id,
                            mustChangePw: lecturer.user?.mustChangePw ?? true,
                            passwordSentAt: lecturer.user?.passwordSentAt ?? null,
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
              print, or send them over WhatsApp now.
            </DialogDescription>
          </DialogHeader>
          {!canSend && (
            <p className="text-xs text-amber-600">{sendBlockedReason}</p>
          )}
          <div className="max-h-80 overflow-y-auto rounded-lg border border-border">
            <Table>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow>
                  <TableHead>Staff no.</TableHead>
                  <TableHead>Full name</TableHead>
                  <TableHead>Phone (login)</TableHead>
                  <TableHead>Temp password</TableHead>
                  <TableHead>Credentials</TableHead>
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
                      {sendCredentialsCell({
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
            <Button
              variant="outline"
              disabled={!canSend || sendingAll || !result?.length}
              onClick={() => result && sendAll(result)}
            >
              {sendingAll ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
              Send all credentials
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
              ? sendCredentialsCell({
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
