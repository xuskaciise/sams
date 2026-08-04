"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Loader2, MoreHorizontal, Plus, Copy } from "lucide-react";
import type {
  Department,
  DeanDepartment,
  Permission,
  Role,
  User,
  UserPermissionOverride,
} from "@prisma/client";
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
import { TableSearchInput } from "@/components/ui/table-search-input";
import { TablePagination } from "@/components/ui/table-pagination";
import { getActionErrorMessage } from "@/lib/action-error";
import { useUrlTableState } from "@/lib/use-url-table-state";
import { userFormSchema, type UserFormInput } from "./schema";
import {
  createUser,
  updateUser,
  resetUserPassword,
  deactivateUser,
  reactivateUser,
} from "./actions";
import {
  UserAccessDialog,
  type RoleWithPermissions,
} from "./user-access-dialog";
import { DeanDepartmentsDialog } from "./dean-departments-dialog";

type UserRow = User & {
  userRoles: { role: Role }[];
  permissionOverrides: UserPermissionOverride[];
  deanDepartments: DeanDepartment[];
};

const EMPTY_VALUES: UserFormInput = {
  role: "",
  email: "",
  fullName: "",
};

// "all" sentinel, not "" — base-ui's Select throws on an empty-string
// item value, so this gets translated to/from "" (useUrlTableState's own
// "no filter" convention) at the call site instead.
const STATUS_ITEMS = [
  { value: "all", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
];

export function UsersClient({
  users,
  roles,
  permissions,
  departments,
  currentUserId,
  total,
  page,
  pageSize,
}: {
  users: UserRow[];
  // Assignable roles (never STUDENT) — feeds the Add-user dropdown, the
  // role filter, and the per-user access dialog, so custom roles show up
  // automatically.
  roles: RoleWithPermissions[];
  permissions: Permission[];
  departments: Department[];
  currentUserId: string;
  total: number;
  page: number;
  pageSize: number;
}) {
  const roleItems = [
    { value: "all", label: "All roles" },
    ...roles.map((r) => ({ value: r.name, label: r.name })),
  ];
  // LECTURER accounts are created only via Lecturer Registration +
  // Lecturer Accounts now — excluded from the Add-user role dropdown
  // specifically (still browsable via the filter above, and existing
  // LECTURER rows still show correctly when editing since openEdit is
  // disabled for them, not hidden).
  const createRoleItems = roles.filter((r) => r.name !== "LECTURER");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<UserRow | null>(null);
  const table = useUrlTableState();
  const [tempPassword, setTempPassword] = useState<{
    identifier: string;
    password: string;
    mode: "created" | "reset";
  } | null>(null);
  const [accessUser, setAccessUser] = useState<UserRow | null>(null);
  const [deanDeptUser, setDeanDeptUser] = useState<UserRow | null>(null);

  const form = useForm<UserFormInput>({
    resolver: zodResolver(userFormSchema),
    defaultValues: EMPTY_VALUES,
  });

  function openCreate() {
    setEditing(null);
    form.reset(EMPTY_VALUES);
    setDialogOpen(true);
  }

  function openEdit(user: UserRow) {
    setEditing(user);
    form.reset({
      role: user.userRoles[0]?.role.name ?? "",
      email: user.email ?? "",
      fullName: user.fullName,
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
        setTempPassword({
          identifier: values.email,
          password: result.tempPassword,
          mode: "created",
        });
      }
      startTransition(() => router.refresh());
    } catch (error) {
      if (error instanceof Error && error.message === "LECTURER_NOT_EDITED_HERE") {
        toast.error("Lecturer accounts are managed from Lecturer Registration / Lecturer Accounts.");
      } else {
        toast.error(
          getActionErrorMessage(
            error,
            "Something went wrong. That email may already be in use."
          )
        );
      }
    }
  }

  async function onResetPassword(user: UserRow) {
    try {
      const result = await resetUserPassword(user.id);
      setTempPassword({
        identifier: user.email ?? user.username,
        password: result.tempPassword,
        mode: "reset",
      });
      startTransition(() => router.refresh());
    } catch (error) {
      if (error instanceof Error && error.message === "CANNOT_RESET_SELF") {
        toast.error("You cannot reset your own password from here.");
      } else {
        toast.error(
          getActionErrorMessage(error, "Something went wrong. Please try again.")
        );
      }
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
        description="Manage ADMIN, DEAN, and custom-role staff accounts. Lecturer accounts are managed from Lecturer Registration / Lecturer Accounts."
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

      <div className="flex flex-wrap gap-3">
        <TableSearchInput
          value={table.search}
          onChange={table.setSearch}
          placeholder="Search by name or email…"
          className="w-full sm:w-72"
        />
        <div className="w-40">
          <Select
            value={table.getFilter("role") || "all"}
            onValueChange={(value) =>
              table.setFilter("role", value === "all" ? "" : (value ?? ""))
            }
            items={roleItems}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="All roles" />
            </SelectTrigger>
            <SelectContent>
              {roleItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-40">
          <Select
            value={table.getFilter("status") || "all"}
            onValueChange={(value) =>
              table.setFilter("status", value === "all" ? "" : (value ?? ""))
            }
            items={STATUS_ITEMS}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="All statuses" />
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
      </div>

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
                <TableCell>{user.email ?? "—"}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {user.userRoles.map(({ role }) => (
                      <Badge key={role.id} variant="secondary">
                        {role.name}
                      </Badge>
                    ))}
                  </div>
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
                      <DropdownMenuItem
                        disabled={user.userRoles.some((ur) => ur.role.name === "LECTURER")}
                        onClick={() => openEdit(user)}
                      >
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setAccessUser(user)}>
                        Roles &amp; permissions
                      </DropdownMenuItem>
                      {user.userRoles.some((ur) => ur.role.name === "DEAN") && (
                        <DropdownMenuItem onClick={() => setDeanDeptUser(user)}>
                          Faculties overseen
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        disabled={user.id === currentUserId}
                        onClick={() => onResetPassword(user)}
                      >
                        Reset password
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={user.id === currentUserId}
                        onClick={() => onToggleActive(user)}
                      >
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
                  No users match these filters.
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
                      items={(editing ? roles : createRoleItems).map((r) => ({
                        value: r.name,
                        label: r.name,
                      }))}
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select a role" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {(editing ? roles : createRoleItems).map((r) => (
                          <SelectItem key={r.id} value={r.name}>
                            {r.name}
                          </SelectItem>
                        ))}
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
            <DialogTitle>
              {tempPassword?.mode === "reset" ? "Password reset" : "User created"}
            </DialogTitle>
            <DialogDescription>
              Share this temporary password with {tempPassword?.identifier}. It
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

      {accessUser && (
        <UserAccessDialog
          key={accessUser.id}
          open
          onOpenChange={(open) => !open && setAccessUser(null)}
          userId={accessUser.id}
          userName={accessUser.fullName}
          initialRoleIds={accessUser.userRoles.map((ur) => ur.role.id)}
          initialOverrides={accessUser.permissionOverrides.map((o) => ({
            permissionId: o.permissionId,
            effect: o.effect,
          }))}
          roles={roles}
          permissions={permissions}
          onSaved={() => startTransition(() => router.refresh())}
        />
      )}

      {deanDeptUser && (
        <DeanDepartmentsDialog
          key={deanDeptUser.id}
          open
          onOpenChange={(open) => !open && setDeanDeptUser(null)}
          userId={deanDeptUser.id}
          userName={deanDeptUser.fullName}
          initialDepartmentIds={deanDeptUser.deanDepartments.map(
            (dd) => dd.departmentId
          )}
          departments={departments}
          onSaved={() => startTransition(() => router.refresh())}
        />
      )}
    </div>
  );
}
