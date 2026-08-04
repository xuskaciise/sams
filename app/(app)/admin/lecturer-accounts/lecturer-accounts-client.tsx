"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { KeyRound, Loader2, Printer, Download } from "lucide-react";
import type { Department, Lecturer, User } from "@prisma/client";
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
  type GeneratedLecturerAccount,
} from "./actions";

// Sentinel for "lecturers with no department set" — mirrors the "all"/
// non-empty-sentinel convention used elsewhere in this app for a Select
// value that isn't a real id (see e.g. Assignments' ALL_SEMESTERS_VALUE).
export const UNASSIGNED_VALUE = "unassigned";

type LecturerRow = Lecturer & { user: User | null };

type AccountStatus = "No phone" | "No account" | "Active" | "Locked";

function getStatus(lecturer: LecturerRow): AccountStatus {
  if (!lecturer.user) {
    return lecturer.phoneNumber ? "No account" : "No phone";
  }
  if (lecturer.user.lockedUntil && lecturer.user.lockedUntil > new Date()) {
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

export function LecturerAccountsClient({
  departments,
  selectedDepartmentId,
  lecturers,
}: {
  departments: Department[];
  selectedDepartmentId: string;
  lecturers: LecturerRow[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [generatingDept, setGeneratingDept] = useState(false);
  const [busyLecturerId, setBusyLecturerId] = useState<string | null>(null);
  const [result, setResult] = useState<GeneratedLecturerAccount[] | null>(null);
  const [singleResult, setSingleResult] = useState<{
    staffNo: string;
    fullName: string;
    tempPassword: string;
  } | null>(null);

  const eligibleForBulk = lecturers.filter((l) => !l.user && l.phoneNumber).length;

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
      setSingleResult({
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
      setSingleResult({
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
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader className="sticky top-0 bg-card">
              <TableRow>
                <TableHead>Staff no.</TableHead>
                <TableHead>Full name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-40" />
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
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busyLecturerId === lecturer.id}
                          onClick={() => onResetPassword(lecturer)}
                        >
                          Reset password
                        </Button>
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
      )}

      <Dialog
        open={!!result}
        onOpenChange={(open) => !open && setResult(null)}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Accounts generated</DialogTitle>
            <DialogDescription>
              These temporary passwords are shown only this once — they
              can&apos;t be viewed again after you close this dialog. Each
              lecturer logs in with their PHONE NUMBER, not email. Download
              or print them now.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-80 overflow-y-auto rounded-lg border border-border">
            <Table>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow>
                  <TableHead>Staff no.</TableHead>
                  <TableHead>Full name</TableHead>
                  <TableHead>Phone (login)</TableHead>
                  <TableHead>Temp password</TableHead>
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
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="flex gap-2">
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
          <Button onClick={() => setSingleResult(null)}>Done</Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
