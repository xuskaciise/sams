"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Loader2, MoreHorizontal, Plus, Copy } from "lucide-react";
import type { Class, Lecturer, Student, User } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
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
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import { getActionErrorMessage } from "@/lib/action-error";
import { userFormSchema, type UserFormInput } from "./schema";
import {
  createUser,
  updateUser,
  deactivateUser,
  reactivateUser,
} from "./actions";

type UserRow = User & {
  lecturerProfile: Lecturer | null;
  studentProfile: Student | null;
};

const ROLE_LABELS: Record<UserRow["role"], string> = {
  ADMIN: "Admin",
  DEAN: "Dean",
  LECTURER: "Lecturer",
  STUDENT: "Student",
};

const EMPTY_VALUES: UserFormInput = {
  role: "STUDENT",
  email: "",
  fullName: "",
  staffNo: "",
  title: "",
  studentNo: "",
  classId: "",
};

export function UsersClient({
  users,
  classes,
}: {
  users: UserRow[];
  classes: Class[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [tempPassword, setTempPassword] = useState<{
    email: string;
    password: string;
  } | null>(null);

  const form = useForm<UserFormInput>({
    resolver: zodResolver(userFormSchema),
    defaultValues: EMPTY_VALUES,
  });

  const role = form.watch("role");

  function openCreate() {
    setEditing(null);
    form.reset(EMPTY_VALUES);
    setDialogOpen(true);
  }

  function openEdit(user: UserRow) {
    setEditing(user);
    form.reset({
      role: user.role,
      email: user.email,
      fullName: user.fullName,
      staffNo: user.lecturerProfile?.staffNo ?? "",
      title: user.lecturerProfile?.title ?? "",
      studentNo: user.studentProfile?.studentNo ?? "",
      classId: user.studentProfile?.classId ?? "",
    });
    setDialogOpen(true);
  }

  async function onSubmit(values: UserFormInput) {
    try {
      if (editing) {
        await updateUser(editing.id, values);
        toast.success("User updated.");
        setDialogOpen(false);
      } else {
        const result = await createUser(values);
        toast.success("User created.");
        setDialogOpen(false);
        setTempPassword({ email: values.email, password: result.tempPassword });
      }
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(
        getActionErrorMessage(
          error,
          "Something went wrong. That email or ID number may already be in use."
        )
      );
    }
  }

  async function onToggleActive(user: UserRow) {
    try {
      if (user.deletedAt) {
        await reactivateUser(user.id);
        toast.success("User reactivated.");
      } else {
        await deactivateUser(user.id);
        toast.success("User deactivated.");
      }
      startTransition(() => router.refresh());
    } catch (error) {
      if (error instanceof Error && error.message === "CANNOT_DEACTIVATE_SELF") {
        toast.error("You cannot deactivate your own account.");
      } else {
        toast.error(
          getActionErrorMessage(error, "Something went wrong. Please try again.")
        );
      }
    }
  }

  async function copyPassword() {
    if (!tempPassword) return;
    try {
      await navigator.clipboard.writeText(tempPassword.password);
      toast.success("Copied to clipboard.");
    } catch {
      // clipboard API unavailable — password is still visible on screen
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Users"
        description="Manage user accounts and roles."
        action={
          <Button onClick={openCreate} disabled={isPending}>
            {isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            Add user
          </Button>
        }
      />

      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((user, i) => (
              <TableRow
                key={user.id}
                className={i % 2 === 1 ? "bg-muted/30" : undefined}
              >
                <TableCell className="font-medium">{user.fullName}</TableCell>
                <TableCell>{user.email}</TableCell>
                <TableCell>
                  <Badge variant="secondary">{ROLE_LABELS[user.role]}</Badge>
                </TableCell>
                <TableCell>
                  <Badge variant={user.deletedAt ? "outline" : "published"}>
                    {user.deletedAt ? "Inactive" : "Active"}
                  </Badge>
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={<Button variant="ghost" size="icon-sm" />}
                    >
                      <MoreHorizontal className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => openEdit(user)}>
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => onToggleActive(user)}>
                        {user.deletedAt ? "Reactivate" : "Deactivate"}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
            {users.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="text-center text-muted-foreground"
                >
                  No users yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit user" : "Add user"}</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              className="flex flex-col gap-4"
            >
              <FormField
                control={form.control}
                name="role"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Role</FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                      disabled={!!editing}
                      items={Object.entries(ROLE_LABELS).map(([value, label]) => ({
                        value,
                        label,
                      }))}
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select a role" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="ADMIN">Admin</SelectItem>
                        <SelectItem value="DEAN">Dean</SelectItem>
                        <SelectItem value="LECTURER">Lecturer</SelectItem>
                        <SelectItem value="STUDENT">Student</SelectItem>
                      </SelectContent>
                    </Select>
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
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email</FormLabel>
                    <FormControl>
                      <Input type="email" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {role === "LECTURER" && (
                <>
                  <FormField
                    control={form.control}
                    name="staffNo"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Staff number</FormLabel>
                        <FormControl>
                          <Input {...field} />
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
                </>
              )}

              {role === "STUDENT" && (
                <>
                  <FormField
                    control={form.control}
                    name="studentNo"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Student number</FormLabel>
                        <FormControl>
                          <Input {...field} />
                        </FormControl>
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
                        <Select
                          value={field.value}
                          onValueChange={field.onChange}
                          items={classes.map((cls) => ({
                            value: cls.id,
                            label: cls.name,
                          }))}
                        >
                          <FormControl>
                            <SelectTrigger className="w-full">
                              <SelectValue placeholder="Select a class" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {classes.map((cls) => (
                              <SelectItem key={cls.id} value={cls.id}>
                                {cls.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </>
              )}

              <Button
                type="submit"
                disabled={form.formState.isSubmitting}
                className="mt-2"
              >
                {editing ? "Save changes" : "Create user"}
              </Button>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!tempPassword}
        onOpenChange={(open) => !open && setTempPassword(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>User created</DialogTitle>
            <DialogDescription>
              Share this temporary password with {tempPassword?.email}. It
              won&apos;t be shown again.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted p-3 font-mono text-sm">
            <span className="flex-1 break-all">{tempPassword?.password}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={copyPassword}
            >
              <Copy className="size-4" />
              <span className="sr-only">Copy password</span>
            </Button>
          </div>
          <Button onClick={() => setTempPassword(null)}>Done</Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
