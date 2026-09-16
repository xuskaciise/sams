"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { KeyRound, Loader2, Printer, Download } from "lucide-react";
import type { Class, Student, User } from "@prisma/client";
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
import { formatClassLabel } from "@/lib/class-label";
import {
  generateAccountsForClass,
  generateAccountForStudent,
  resetStudentPassword,
  type GeneratedAccount,
  type SkippedAccount,
} from "./actions";

type StudentRow = Student & { user: User | null };

type AccountStatus = "No phone" | "No account" | "Active" | "Locked";

// A student with no phoneNumber on file gets its own status, distinct
// from "No account" — mirrors the identical "No phone" treatment on
// Lecturer Accounts (admin/lecturer-accounts/lecturer-accounts-client.tsx),
// since the temp password is now derived from the phone number for both.
function getStatus(student: StudentRow): AccountStatus {
  if (!student.user) {
    return student.phoneNumber ? "No account" : "No phone";
  }
  if (student.user.lockedUntil && student.user.lockedUntil > new Date()) {
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

const NO_PHONE_MESSAGE =
  "This student has no phone number — add one before generating an account.";

function downloadCsv(accounts: GeneratedAccount[]) {
  const header = "Student ID,Full Name,Temporary Password";
  const rows = accounts.map(
    (a) => `${a.studentNo},"${a.fullName}",${a.tempPassword}`
  );
  const csv = [header, ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "student-accounts.csv";
  link.click();
  URL.revokeObjectURL(url);
}

function printAccounts(accounts: GeneratedAccount[]) {
  const win = window.open("", "_blank");
  if (!win) return;
  const rows = accounts
    .map(
      (a) =>
        `<tr><td>${a.studentNo}</td><td>${a.fullName}</td><td>${a.tempPassword}</td></tr>`
    )
    .join("");
  win.document.write(`
    <html>
      <head>
        <title>Student temporary passwords</title>
        <style>
          body { font-family: sans-serif; padding: 24px; }
          table { border-collapse: collapse; width: 100%; }
          th, td { border: 1px solid #ccc; padding: 8px 12px; text-align: left; }
          th { background: #f3f4f6; }
        </style>
      </head>
      <body>
        <h2>Student temporary passwords</h2>
        <p>These passwords are shown only once. Distribute securely.</p>
        <table>
          <thead><tr><th>Student ID</th><th>Full Name</th><th>Temporary Password</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </body>
    </html>
  `);
  win.document.close();
  win.focus();
  win.print();
}

export function StudentAccountsClient({
  classes,
  selectedClassId,
  students,
}: {
  classes: Class[];
  selectedClassId: string;
  students: StudentRow[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [generatingClass, setGeneratingClass] = useState(false);
  const [busyStudentId, setBusyStudentId] = useState<string | null>(null);
  const [result, setResult] = useState<{
    created: GeneratedAccount[];
    skipped: SkippedAccount[];
  } | null>(null);
  const [singleResult, setSingleResult] = useState<{
    studentNo: string;
    fullName: string;
    tempPassword: string;
  } | null>(null);

  const withoutAccountCount = students.filter((s) => !s.user).length;

  function onClassChange(classId: string) {
    if (!classId) return;
    router.push(`/admin/students?tab=student-accounts&classId=${classId}`);
  }

  async function onGenerateForClass() {
    setGeneratingClass(true);
    try {
      const { created, skipped } = await generateAccountsForClass(
        selectedClassId
      );
      if (created.length === 0 && skipped.length === 0) {
        toast.info("Every student in this class already has an account.");
      } else {
        if (created.length === 0) {
          toast.warning(
            `No accounts created — ${skipped.length} student(s) have no phone number on file.`
          );
        }
        setResult({ created, skipped });
      }
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(
        getActionErrorMessage(error, "Something went wrong. Please try again.")
      );
    } finally {
      setGeneratingClass(false);
    }
  }

  async function onGenerateForStudent(student: StudentRow) {
    setBusyStudentId(student.id);
    try {
      const { tempPassword } = await generateAccountForStudent(student.id);
      setSingleResult({
        studentNo: student.studentNo,
        fullName: student.fullName,
        tempPassword,
      });
      startTransition(() => router.refresh());
    } catch (error) {
      if (error instanceof Error && error.message === "NO_PHONE_NUMBER") {
        toast.error(NO_PHONE_MESSAGE);
      } else {
        toast.error(
          getActionErrorMessage(error, "Something went wrong. Please try again.")
        );
      }
    } finally {
      setBusyStudentId(null);
    }
  }

  async function onResetPassword(student: StudentRow) {
    setBusyStudentId(student.id);
    try {
      const { tempPassword } = await resetStudentPassword(student.id);
      setSingleResult({
        studentNo: student.studentNo,
        fullName: student.fullName,
        tempPassword,
      });
      startTransition(() => router.refresh());
    } catch (error) {
      if (error instanceof Error && error.message === "NO_PHONE_NUMBER") {
        toast.error(NO_PHONE_MESSAGE);
      } else {
        toast.error(
          getActionErrorMessage(error, "Something went wrong. Please try again.")
        );
      }
    } finally {
      setBusyStudentId(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Student Accounts"
        description="Generate and reset student logins, per class."
        action={
          selectedClassId && (
            <Button
              onClick={onGenerateForClass}
              disabled={generatingClass || withoutAccountCount === 0}
            >
              {generatingClass ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <KeyRound className="size-4" />
              )}
              Generate accounts for this class
            </Button>
          )
        }
      />

      <div className="max-w-xs">
        <SearchableSelect
          value={selectedClassId}
          onValueChange={onClassChange}
          items={classes.map((cls) => ({ value: cls.id, label: formatClassLabel(cls) }))}
          placeholder="Select a class"
          searchPlaceholder="Search classes…"
          className="w-full"
        />
      </div>

      {selectedClassId && (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader className="sticky top-0 bg-card">
              <TableRow>
                <TableHead>Student ID</TableHead>
                <TableHead>Full name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-40" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {students.map((student, i) => {
                const status = getStatus(student);
                return (
                  <TableRow
                    key={student.id}
                    className={i % 2 === 1 ? "bg-muted/30" : undefined}
                  >
                    <TableCell className="font-medium">
                      {student.studentNo}
                    </TableCell>
                    <TableCell>{student.fullName}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[status]}>{status}</Badge>
                    </TableCell>
                    <TableCell>
                      {status === "No phone" ? (
                        <span
                          className="text-xs text-muted-foreground"
                          title={NO_PHONE_MESSAGE}
                        >
                          Set a phone number first
                        </span>
                      ) : status === "No account" ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busyStudentId === student.id}
                          onClick={() => onGenerateForStudent(student)}
                        >
                          Generate account
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={
                            busyStudentId === student.id || !student.phoneNumber
                          }
                          title={
                            student.phoneNumber ? undefined : NO_PHONE_MESSAGE
                          }
                          onClick={() => onResetPassword(student)}
                        >
                          Reset password
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {students.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={4}
                    className="text-center text-muted-foreground"
                  >
                    No students in this class.
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
              can&apos;t be viewed again after you close this dialog. Download
              or print them now.
            </DialogDescription>
          </DialogHeader>
          {result && result.created.length > 0 && (
            <div className="max-h-80 overflow-y-auto rounded-lg border border-border">
              <Table>
                <TableHeader className="sticky top-0 bg-card">
                  <TableRow>
                    <TableHead>Student ID</TableHead>
                    <TableHead>Full name</TableHead>
                    <TableHead>Temp password</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.created.map((a) => (
                    <TableRow key={a.studentNo}>
                      <TableCell>{a.studentNo}</TableCell>
                      <TableCell>{a.fullName}</TableCell>
                      <TableCell className="font-mono">
                        {a.tempPassword}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {result && result.skipped.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <p className="text-sm font-medium text-amber-700">
                Skipped ({result.skipped.length}) — no phone number on file
              </p>
              <div className="max-h-40 overflow-y-auto rounded-lg border border-border">
                <Table>
                  <TableHeader className="sticky top-0 bg-card">
                    <TableRow>
                      <TableHead>Student ID</TableHead>
                      <TableHead>Full name</TableHead>
                      <TableHead>Reason</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.skipped.map((s) => (
                      <TableRow key={s.studentNo}>
                        <TableCell>{s.studentNo}</TableCell>
                        <TableCell>{s.fullName}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {s.reason}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={!result || result.created.length === 0}
              onClick={() => result && downloadCsv(result.created)}
            >
              <Download className="size-4" />
              Download CSV
            </Button>
            <Button
              variant="outline"
              disabled={!result || result.created.length === 0}
              onClick={() => result && printAccounts(result.created)}
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
              Share this with {singleResult?.fullName} ({singleResult?.studentNo}
              ). It won&apos;t be shown again.
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
