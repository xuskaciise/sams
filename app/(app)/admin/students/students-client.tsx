"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Loader2, UserPlus, Upload } from "lucide-react";
import type { Class, Student, User } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { BulkImportDialog } from "@/components/admin/bulk-import-dialog";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  studentRegistrationSchema,
  type StudentRegistrationInput,
} from "./schema";
import { registerStudent } from "./actions";
import {
  downloadStudentImportTemplate,
  previewStudentImport,
  confirmStudentImport,
} from "./bulk-import-actions";

const IMPORT_COLUMNS = [
  { key: "student_no", label: "Student ID" },
  { key: "full_name", label: "Full name" },
  { key: "gender", label: "Gender" },
  { key: "class_code", label: "Class code" },
];

type StudentRow = Student & { class: Class; user: User | null };

const GENDER_LABELS: Record<"MALE" | "FEMALE", string> = {
  MALE: "Male",
  FEMALE: "Female",
};

export function StudentsClient({
  students,
  classes,
  total,
  page,
  pageSize,
}: {
  students: StudentRow[];
  classes: Class[];
  total: number;
  page: number;
  pageSize: number;
}) {
  const router = useRouter();
  const [importOpen, setImportOpen] = useState(false);
  const table = useUrlTableState();

  const form = useForm<StudentRegistrationInput>({
    resolver: zodResolver(studentRegistrationSchema),
    defaultValues: {
      studentNo: "",
      fullName: "",
      gender: undefined,
      classId: "",
    },
  });

  async function onSubmit(values: StudentRegistrationInput) {
    try {
      await registerStudent(values);
      toast.success("Student registered.");
      // Quick repeated entry: clear identifying fields but keep the class
      // selected, since a whole roster is usually entered in one sitting.
      form.reset({
        studentNo: "",
        fullName: "",
        gender: undefined,
        classId: values.classId,
      });
      form.setFocus("studentNo");
      router.refresh();
    } catch (error) {
      if (error instanceof Error && error.message === "STUDENT_NO_TAKEN") {
        form.setError("studentNo", {
          message: "That student ID is already registered.",
        });
      } else {
        toast.error(
          getActionErrorMessage(error, "Something went wrong. Please try again.")
        );
      }
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Student Registration"
        description="Register students by ID, name, gender, and class. No account is created here — generate logins from Student Accounts."
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
        title="Bulk import students"
        description="Upload a spreadsheet to register many students at once. Accounts are not created here — use Student Accounts afterward."
        columns={IMPORT_COLUMNS}
        onDownloadTemplate={downloadStudentImportTemplate}
        onPreview={previewStudentImport}
        onConfirm={async (rows, fileName) => {
          const result = await confirmStudentImport(rows, fileName);
          router.refresh();
          return result;
        }}
      />

      <Card>
        <CardHeader>
          <CardTitle>Register a student</CardTitle>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5 lg:items-end"
            >
              <FormField
                control={form.control}
                name="studentNo"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Student ID</FormLabel>
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
                name="gender"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Gender</FormLabel>
                    <Select
                      value={field.value ?? ""}
                      onValueChange={field.onChange}
                      items={[
                        { value: "MALE", label: "Male" },
                        { value: "FEMALE", label: "Female" },
                      ]}
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="MALE">Male</SelectItem>
                        <SelectItem value="FEMALE">Female</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="classId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Class</FormLabel>
                    <SearchableSelect
                      value={field.value}
                      onValueChange={field.onChange}
                      items={classes.map((cls) => ({
                        value: cls.id,
                        label: cls.name,
                      }))}
                      placeholder="Select a class"
                      searchPlaceholder="Search classes…"
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
                Register student
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-3">
        <TableSearchInput
          value={table.search}
          onChange={table.setSearch}
          placeholder="Search by name or student ID…"
          className="w-full sm:w-72"
        />
        <div className="w-52">
          <SearchableSelect
            value={table.getFilter("classId")}
            onValueChange={(value) => table.setFilter("classId", value)}
            items={[
              { value: "", label: "All classes" },
              ...classes.map((cls) => ({ value: cls.id, label: cls.name })),
            ]}
            placeholder="Class"
            searchPlaceholder="Search classes…"
            className="w-full"
          />
        </div>
      </div>

      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead>Student ID</TableHead>
              <TableHead>Full name</TableHead>
              <TableHead>Gender</TableHead>
              <TableHead>Class</TableHead>
              <TableHead>Account</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {students.map((student, i) => (
              <TableRow
                key={student.id}
                className={i % 2 === 1 ? "bg-muted/30" : undefined}
              >
                <TableCell className="font-medium">
                  {student.studentNo}
                </TableCell>
                <TableCell>{student.fullName}</TableCell>
                <TableCell>
                  {student.gender ? GENDER_LABELS[student.gender] : "—"}
                </TableCell>
                <TableCell>{student.class.name}</TableCell>
                <TableCell>
                  <Badge variant={student.user ? "published" : "outline"}>
                    {student.user ? "Has account" : "No account"}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
            {students.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="text-center text-muted-foreground"
                >
                  No students match these filters.
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
    </div>
  );
}
