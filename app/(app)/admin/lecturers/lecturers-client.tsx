"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Loader2, UserPlus, Upload, Pencil, Trash2 } from "lucide-react";
import type { Department, Lecturer, User } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { BulkImportDialog } from "@/components/admin/bulk-import-dialog";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
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
import { TableSearchInput } from "@/components/ui/table-search-input";
import { TablePagination } from "@/components/ui/table-pagination";
import { useUrlTableState } from "@/lib/use-url-table-state";
import { getActionErrorMessage } from "@/lib/action-error";
import {
  lecturerRegistrationSchema,
  type LecturerRegistrationInput,
} from "./schema";
import {
  registerLecturer,
  updateLecturerPhoneNumber,
  updateLecturerDepartment,
  deleteLecturer,
} from "./actions";
import {
  downloadLecturerImportTemplate,
  previewLecturerImport,
  confirmLecturerImport,
} from "./bulk-import-actions";

const IMPORT_COLUMNS = [
  { key: "staff_no", label: "Staff no." },
  { key: "full_name", label: "Full name" },
  { key: "phone_number", label: "Phone number" },
  { key: "department", label: "Department (code or name)" },
];

type LecturerRow = Lecturer & { department: Department | null; user: User | null };

export function LecturersClient({
  lecturers,
  departments,
  total,
  page,
  pageSize,
}: {
  lecturers: LecturerRow[];
  departments: Department[];
  total: number;
  page: number;
  pageSize: number;
}) {
  const router = useRouter();
  const [importOpen, setImportOpen] = useState(false);
  const table = useUrlTableState();
  const [phoneEditLecturer, setPhoneEditLecturer] = useState<LecturerRow | null>(null);
  const [phoneValue, setPhoneValue] = useState("");
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [savingPhone, setSavingPhone] = useState(false);
  const [deptEditLecturer, setDeptEditLecturer] = useState<LecturerRow | null>(null);
  const [deptValue, setDeptValue] = useState("");
  const [savingDept, setSavingDept] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const form = useForm<LecturerRegistrationInput>({
    resolver: zodResolver(lecturerRegistrationSchema),
    defaultValues: {
      staffNo: "",
      fullName: "",
      phoneNumber: "",
      title: "",
      departmentId: "",
    },
  });

  async function onSubmit(values: LecturerRegistrationInput) {
    try {
      await registerLecturer(values);
      toast.success("Lecturer registered.");
      // Quick repeated entry: clear identifying fields but keep the
      // department selected, since a whole faculty roster is usually
      // entered in one sitting.
      form.reset({
        staffNo: "",
        fullName: "",
        phoneNumber: "",
        title: "",
        departmentId: values.departmentId,
      });
      form.setFocus("staffNo");
      router.refresh();
    } catch (error) {
      if (error instanceof Error && error.message === "STAFF_NO_TAKEN") {
        form.setError("staffNo", {
          message: "That staff number is already registered.",
        });
      } else if (error instanceof Error && error.message === "PHONE_NUMBER_TAKEN") {
        form.setError("phoneNumber", {
          message: "That phone number is already registered to another lecturer.",
        });
      } else {
        toast.error(
          getActionErrorMessage(error, "Something went wrong. Please try again.")
        );
      }
    }
  }

  function openPhoneEdit(lecturer: LecturerRow) {
    setPhoneEditLecturer(lecturer);
    setPhoneValue(lecturer.phoneNumber ?? "");
    setPhoneError(null);
  }

  async function savePhone() {
    if (!phoneEditLecturer) return;
    setSavingPhone(true);
    setPhoneError(null);
    try {
      await updateLecturerPhoneNumber(phoneEditLecturer.id, {
        phoneNumber: phoneValue,
      });
      toast.success("Phone number updated.");
      setPhoneEditLecturer(null);
      router.refresh();
    } catch (error) {
      if (error instanceof Error && error.message === "PHONE_NUMBER_TAKEN") {
        setPhoneError(
          "That phone number is already in use by another lecturer or account."
        );
      } else if (
        error instanceof Error &&
        error.message === "PHONE_NUMBER_REQUIRED"
      ) {
        setPhoneError("A phone number is required.");
      } else {
        setPhoneError(
          getActionErrorMessage(error, "Could not save that phone number.")
        );
      }
    } finally {
      setSavingPhone(false);
    }
  }

  function openDeptEdit(lecturer: LecturerRow) {
    setDeptEditLecturer(lecturer);
    setDeptValue(lecturer.departmentId ?? "");
  }

  async function saveDept() {
    if (!deptEditLecturer) return;
    setSavingDept(true);
    try {
      await updateLecturerDepartment(deptEditLecturer.id, {
        departmentId: deptValue,
      });
      toast.success("Department updated.");
      setDeptEditLecturer(null);
      router.refresh();
    } catch (error) {
      toast.error(
        getActionErrorMessage(error, "Could not save that department.")
      );
    } finally {
      setSavingDept(false);
    }
  }

  async function onDelete(lecturer: LecturerRow) {
    if (
      !window.confirm(
        `Delete ${lecturer.fullName} (${lecturer.staffNo})? This cannot be undone.`
      )
    ) {
      return;
    }
    setDeletingId(lecturer.id);
    try {
      await deleteLecturer(lecturer.id);
      toast.success("Lecturer deleted.");
      router.refresh();
    } catch (error) {
      if (error instanceof Error && error.message === "HAS_ACCOUNT") {
        toast.error(
          "This lecturer has a login account — deactivate it from Users instead of deleting the profile."
        );
      } else if (error instanceof Error && error.message === "HAS_ASSIGNMENTS") {
        toast.error(
          "This lecturer is assigned to teach at least one course — remove those assignments first."
        );
      } else {
        toast.error(
          getActionErrorMessage(error, "Something went wrong. Please try again.")
        );
      }
    } finally {
      setDeletingId(null);
    }
  }

  function accountStatus(lecturer: LecturerRow) {
    if (!lecturer.user) return { label: "No account", variant: "outline" as const };
    if (lecturer.user.lockedUntil && lecturer.user.lockedUntil > new Date()) {
      return { label: "Locked", variant: "destructive" as const };
    }
    return { label: "Active", variant: "published" as const };
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Lecturer Registration"
        description="Register lecturers by staff number, name, phone, and department. No account is created here — generate logins from Lecturer Accounts."
        action={
          <Button variant="outline" onClick={() => setImportOpen(true)}>
            <Upload className="size-4" />
            Bulk import
          </Button>
        }
      />

      <BulkImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        title="Bulk import lecturers"
        description="Upload a spreadsheet to register many lecturers at once. Accounts are not created here — use Lecturer Accounts afterward."
        columns={IMPORT_COLUMNS}
        onDownloadTemplate={downloadLecturerImportTemplate}
        onPreview={previewLecturerImport}
        onConfirm={async (rows, fileName) => {
          const result = await confirmLecturerImport(rows, fileName);
          router.refresh();
          return result;
        }}
      />

      <Card>
        <CardHeader>
          <CardTitle>Register a lecturer</CardTitle>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-6 lg:items-end"
            >
              <FormField
                control={form.control}
                name="staffNo"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Staff number</FormLabel>
                    <FormControl>
                      <Input {...field} autoFocus />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="fullName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Full name</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="phoneNumber"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Phone number</FormLabel>
                    <FormControl>
                      <Input placeholder="+2526XXXXXXXX" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Title (optional)</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. Dr." {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="departmentId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Department (optional)</FormLabel>
                    <SearchableSelect
                      value={field.value ?? ""}
                      onValueChange={field.onChange}
                      items={departments.map((d) => ({
                        value: d.id,
                        label: `${d.name} (${d.code})`,
                      }))}
                      placeholder="Select a department"
                      searchPlaceholder="Search departments…"
                      className="w-full"
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <UserPlus className="size-4" />
                )}
                Register lecturer
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-3">
        <TableSearchInput
          value={table.search}
          onChange={table.setSearch}
          placeholder="Search by name or staff number…"
          className="w-full sm:w-72"
        />
        <div className="w-56">
          <SearchableSelect
            value={table.getFilter("departmentId")}
            onValueChange={(value) => table.setFilter("departmentId", value)}
            items={[
              { value: "", label: "All departments" },
              ...departments.map((d) => ({ value: d.id, label: `${d.name} (${d.code})` })),
            ]}
            placeholder="Department"
            searchPlaceholder="Search departments…"
            className="w-full"
          />
        </div>
      </div>

      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead>Staff no.</TableHead>
              <TableHead>Full name</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead>Department</TableHead>
              <TableHead>Account</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {lecturers.map((lecturer, i) => {
              const status = accountStatus(lecturer);
              return (
                <TableRow
                  key={lecturer.id}
                  className={i % 2 === 1 ? "bg-muted/30" : undefined}
                >
                  <TableCell className="font-medium">
                    {lecturer.staffNo}
                  </TableCell>
                  <TableCell>
                    {lecturer.title ? `${lecturer.title} ` : ""}
                    {lecturer.fullName}
                  </TableCell>
                  <TableCell>
                    <button
                      type="button"
                      onClick={() => openPhoneEdit(lecturer)}
                      className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
                    >
                      {lecturer.phoneNumber ?? "Set phone…"}
                      <Pencil className="size-3 shrink-0" />
                    </button>
                  </TableCell>
                  <TableCell>
                    <button
                      type="button"
                      onClick={() => openDeptEdit(lecturer)}
                      className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
                    >
                      {lecturer.department
                        ? `${lecturer.department.name} (${lecturer.department.code})`
                        : "Set department…"}
                      <Pencil className="size-3 shrink-0" />
                    </button>
                  </TableCell>
                  <TableCell>
                    <Badge variant={status.variant}>{status.label}</Badge>
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={deletingId === lecturer.id}
                      onClick={() => onDelete(lecturer)}
                    >
                      {deletingId === lecturer.id ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Trash2 className="size-4" />
                      )}
                      <span className="sr-only">Delete lecturer</span>
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
            {lecturers.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="text-center text-muted-foreground"
                >
                  No lecturers match these filters.
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

      <Dialog
        open={!!phoneEditLecturer}
        onOpenChange={(open) => !open && setPhoneEditLecturer(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Phone number — {phoneEditLecturer?.fullName}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Input
              placeholder="+2526XXXXXXXX"
              value={phoneValue}
              onChange={(e) => setPhoneValue(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Doubles as this lecturer&apos;s login identifier once an
              account is generated — required, and must be unique.
            </p>
            {phoneError && (
              <p className="text-sm text-destructive">{phoneError}</p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setPhoneEditLecturer(null)}
            >
              Cancel
            </Button>
            <Button type="button" onClick={savePhone} disabled={savingPhone}>
              {savingPhone && <Loader2 className="size-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!deptEditLecturer}
        onOpenChange={(open) => !open && setDeptEditLecturer(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Department — {deptEditLecturer?.fullName}
            </DialogTitle>
          </DialogHeader>
          <SearchableSelect
            value={deptValue}
            onValueChange={setDeptValue}
            items={[
              { value: "", label: "Unassigned" },
              ...departments.map((d) => ({ value: d.id, label: `${d.name} (${d.code})` })),
            ]}
            placeholder="Select a department"
            searchPlaceholder="Search departments…"
            className="w-full"
          />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeptEditLecturer(null)}
            >
              Cancel
            </Button>
            <Button type="button" onClick={saveDept} disabled={savingDept}>
              {savingDept && <Loader2 className="size-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
